# Email templates

Plain-text emails sent by the server. Edit the text here - no code change needed (deployed with the next push).

- First line: `Temat: ...` (or `Subject: ...`) - the subject.
- Then an empty line, then the body.
- `{{name}}` is replaced with a value; the placeholders each template gets are listed at its top in a
  `#` comment block (comment lines at the very top are dropped).
- Language versions: `name.pl.txt`, `name.en.txt`, ... (falls back to `name.pl.txt`, then `name.txt`).

A NEW template still needs the owner's approval before it is switched on (its *_APPROVED flag in render.yaml).
