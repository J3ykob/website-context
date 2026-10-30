"""bge-reranker-v2-m3 (BAAI, Apache-2.0), int8 ONNX: P(a text answers/offers what a query asks), any language.
Deterministic: fixed weights, one forward pass, no sampling - the same pair always gets the same score."""
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

MAX_LEN = 512


class Reranker:
    def __init__(self, path="/model"):
        self.tok = Tokenizer.from_file(f"{path}/tokenizer.json")
        self.tok.enable_truncation(max_length=MAX_LEN)
        self.tok.enable_padding(pad_id=1, pad_token="<pad>")
        so = ort.SessionOptions()
        so.intra_op_num_threads = 0
        self.sess = ort.InferenceSession(f"{path}/onnx/model_int8.onnx", so, providers=["CPUExecutionProvider"])
        self.inputs = {i.name for i in self.sess.get_inputs()}

    def score(self, pairs, batch=16):
        out = []
        for k in range(0, len(pairs), batch):
            enc = self.tok.encode_batch([(q, d) for q, d in pairs[k:k + batch]])
            feed = {"input_ids": np.array([e.ids for e in enc], dtype=np.int64), "attention_mask": np.array([e.attention_mask for e in enc], dtype=np.int64)}
            if "token_type_ids" in self.inputs:
                feed["token_type_ids"] = np.zeros_like(feed["input_ids"])
            logits = self.sess.run(None, feed)[0].reshape(-1)
            out.extend((1 / (1 + np.exp(-logits))).tolist())
        return out
