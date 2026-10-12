"""PII masking: bardsai/eu-pii-anonimization-multilang (int8 ONNX) finds the spans, code turns them into
stable placeholders ([OSOBA_1], [TELEFON_1], ...) and back.

Detection is done by the model only. Code does the label policy, fragment merging, the tenant allowlist
(its own public name/address/phone, brands it sells), placeholder bookkeeping, checksum validation of
spans the model already found (to NAME them NIP/PESEL), and parsing of our own placeholder syntax.
"""
import json
import os

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

MODEL_DIR = os.environ.get("PII_MODEL_DIR", "/model")
_tok = Tokenizer.from_file(f"{MODEL_DIR}/tokenizer.json")
_tok.no_truncation()
_tok.no_padding()
_so = ort.SessionOptions()
_so.intra_op_num_threads = int(os.environ.get("PII_THREADS", "1"))
_sess = ort.InferenceSession(f"{MODEL_DIR}/onnx/model_quantized.onnx", _so, providers=["CPUExecutionProvider"])
_id2label = json.load(open(f"{MODEL_DIR}/config.json"))["id2label"]

# Model label -> placeholder family. Labels not listed are never masked (products, amounts, contract
# numbers, brands, document references).
FAMILY = {
    "PERSON_NAME": "OSOBA", "PERSON_ALIAS": "OSOBA", "PHONE_NUMBER": "TELEFON", "EMAIL_ADDRESS": "EMAIL",
    "CONTACT_HANDLE": "KONTAKT", "POSTAL_ADDRESS": "ADRES", "LOCATION": "ADRES", "GEO_LOCATION": "ADRES",
    "PERSON_IDENTIFIER": "ID", "ORGANIZATION_NAME": "FIRMA", "ORGANIZATION_IDENTIFIER": "ID_FIRMY",
    "BANK_ACCOUNT_IDENTIFIER": "KONTO", "PAYMENT_CARD": "KARTA", "ACCOUNT_IDENTIFIER": "KONTO",
    "DATE_OF_BIRTH": "DATA_UR", "IP_ADDRESS": "IP", "IDENTIFYING_LINK": "LINK", "AUTH_SECRET": "SEKRET",
}
MAX_TOKENS = 510
WINDOW_STEP = 384
DOUBT = 0.1  # PII probability mass that makes an "O" token between two same-type PII tokens part of them
_PII_IDX = [int(i) for i, l in _id2label.items() if l != "O" and FAMILY.get(l[2:])]


def _windows(text):
    """The model reads 512 tokens; longer texts go through overlapping windows."""
    enc = _tok.encode(text)
    ids, offs = enc.ids[1:-1], enc.offsets[1:-1]
    for st in range(0, max(1, len(ids)), WINDOW_STEP):
        yield [0] + ids[st:st + MAX_TOKENS] + [2], [(0, 0)] + offs[st:st + MAX_TOKENS] + [(0, 0)]
        if st + MAX_TOKENS >= len(ids):
            break


def detect(text):
    spans = []
    for ids, offs in _windows(text):
        a = np.array([ids], dtype=np.int64)
        logits = _sess.run(None, {"input_ids": a, "attention_mask": np.ones_like(a)})[0][0]
        prob = np.exp(logits - logits.max(-1, keepdims=True))
        prob /= prob.sum(-1, keepdims=True)
        labs = [_id2label[str(i)] for i in logits.argmax(-1)]
        # Mask on doubt: '@' inside an email the model split in two joins both halves.
        for k in range(1, len(labs) - 1):
            if labs[k] == "O" and prob[k][_PII_IDX].sum() >= DOUBT and labs[k - 1] != "O" and labs[k + 1] != "O" \
                    and labs[k - 1][2:] == labs[k + 1][2:] and FAMILY.get(labs[k - 1][2:]):
                labs[k] = "I-" + labs[k - 1][2:]
                labs[k + 1] = "I-" + labs[k + 1][2:]
        cur = None
        for (s, e), lab in zip(offs, labs):
            if s == e:
                continue
            if lab == "O":
                cur = None
                continue
            if cur and cur["label"] == lab[2:] and lab.startswith("I-"):
                cur["end"] = e
            else:
                cur = dict(start=s, end=e, label=lab[2:])
                spans.append(cur)
    for sp in spans:
        while sp["start"] < sp["end"] and text[sp["start"]].isspace():
            sp["start"] += 1
    # Merge touching or overlapping fragments only (never across ";" or ",").
    spans.sort(key=lambda p: (p["start"], -p["end"]))
    out = []
    for p in spans:
        if out and p["start"] <= out[-1]["end"]:
            q = out[-1]
            if FAMILY.get(q["label"]) is None and FAMILY.get(p["label"]):
                q["label"] = p["label"]
            q["end"] = max(q["end"], p["end"])
        else:
            out.append(dict(p))
    for p in out:  # whole words: 'Mark' + 'u' -> 'Marku'
        while p["start"] > 0 and text[p["start"] - 1].isalnum():
            p["start"] -= 1
        while p["end"] < len(text) and text[p["end"]].isalnum():
            p["end"] += 1
        p["text"] = text[p["start"]:p["end"]]
    return out


def _digits(s):
    return [int(c) for c in s if c.isdigit()]


def nip_ok(s):
    d = _digits(s)
    return len(d) == 10 and sum(w * x for w, x in zip([6, 5, 7, 2, 3, 4, 5, 6, 7], d)) % 11 == d[9]


def pesel_ok(s):
    d = _digits(s)
    return len(d) == 11 and (10 - sum(w * x for w, x in zip([1, 3, 7, 9] * 3, d)) % 10) % 10 == d[10]


def norm(s):
    return "".join(ch.lower() for ch in s if ch.isalnum())


class Vault:
    """One project's mapping. The same value always gets the same placeholder; inflected forms of one
    person link only when unambiguous (a second placeholder is safer than merging two people)."""

    def __init__(self, allow=(), catalog=(), state=None):
        self.allow = [norm(a) for a in allow if norm(a)]
        self.catalog = {norm(b) for b in catalog if norm(b)}
        st = state or {}
        self.by_ph = {k: {"canon": v["canon"], "forms": set(v["forms"])} for k, v in st.get("by_ph", {}).items()}
        self.by_norm = dict(st.get("by_norm", {}))
        self.count = dict(st.get("count", {}))

    def state(self):
        return {"by_ph": {k: {"canon": v["canon"], "forms": sorted(v["forms"])} for k, v in self.by_ph.items()},
                "by_norm": self.by_norm, "count": self.count}

    @staticmethod
    def _stem_eq(a, b):
        k = 0
        while k < min(len(a), len(b)) and a[k] == b[k]:
            k += 1
        return min(len(a), len(b)) >= 4 and k >= max(4, min(len(a), len(b)) - 3)

    def _person_link(self, surface):
        toks = [norm(t) for t in surface.split() if norm(t)]
        for ph, v in self.by_ph.items():
            if not ph.startswith("[OSOBA_"):
                continue
            for f in v["forms"]:
                ft = [norm(t) for t in f.split() if norm(t)]
                if len(toks) >= 2 and len(ft) >= 2:
                    if len(toks) == len(ft) and all(self._stem_eq(a, b) for a, b in zip(toks, ft)):
                        return ph
                elif len(toks) == 1 and any(self._stem_eq(toks[0], b) for b in ft):
                    hits = {p for p, w in self.by_ph.items() if p.startswith("[OSOBA_")
                            for g in w["forms"] for b in (norm(t) for t in g.split()) if self._stem_eq(toks[0], b)}
                    return ph if len(hits) == 1 else None
        return None

    def placeholder(self, fam, surface):
        n = norm(surface)
        if n in self.by_norm:
            ph = self.by_norm[n]
        else:
            ph = self._person_link(surface) if fam == "OSOBA" else None
            if not ph:
                self.count[fam] = self.count.get(fam, 0) + 1
                ph = f"[{fam}_{self.count[fam]}]"
                self.by_ph[ph] = {"canon": surface, "forms": set()}
            self.by_norm[n] = ph
        self.by_ph[ph]["forms"].add(surface)
        return ph

    def mask(self, text):
        out, last, found = [], 0, 0
        for p in detect(text):
            fam = FAMILY.get(p["label"])
            if fam is None:
                continue
            if fam == "ADRES" and not any(ch.isdigit() for ch in p["text"]):
                continue  # a bare city or street name does not identify anyone
            if any(norm(p["text"]) and norm(p["text"]) in a for a in self.allow):
                continue  # the business's own public data
            if fam == "FIRMA" and any(norm(w) in self.catalog for w in p["text"].split()):
                continue  # a brand the business sells
            if fam in ("ID", "ID_FIRMY"):
                fam = "PESEL" if pesel_ok(p["text"]) else "NIP" if nip_ok(p["text"]) else "NR_ID"
            out.append(text[last:p["start"]])
            out.append(self.placeholder(fam, p["text"]))
            last = p["end"]
            found += 1
        out.append(text[last:])
        return "".join(out), found

    def unmask(self, text):
        """Swaps our placeholders back. Reports placeholders we never issued and altered forms of ours
        (lost brackets, spaces, case) - never guesses a repair."""
        res, i, unknown = [], 0, []
        while i < len(text):
            if text[i] == "[":
                j = text.find("]", i)
                tok = text[i:j + 1] if j > 0 else ""
                if tok in self.by_ph:
                    res.append(self.by_ph[tok]["canon"])
                    i = j + 1
                    continue
                inner = tok[1:-1]
                if inner and "_" in inner and inner.rsplit("_", 1)[1].isdigit() and inner.replace("_", "").isalnum() \
                        and inner.isupper():
                    unknown.append(tok)
            res.append(text[i])
            i += 1
        altered, low = [], text.lower()
        for ph in self.by_ph:
            core = ph[1:-1]
            for variant in (core, core.replace("_", " ")):
                k = low.find(variant.lower())
                while k >= 0:
                    end = k + len(variant)
                    # the next char must not extend the number ([OSOBA_1] vs OSOBA_12)
                    if not (end < len(text) and text[end].isdigit()) and \
                            not (k > 0 and text[k - 1] == "[" and text[end:end + 1] == "]"):
                        altered.append(text[max(0, k - 1):end + 1])
                    k = low.find(variant.lower(), k + 1)
        return "".join(res), sorted(set(unknown)), sorted(set(altered))
