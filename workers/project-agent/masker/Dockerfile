# The platform's exec/file plumbing (sandbox-shim) - same donor image as the agent sandbox.
ARG SANDBOX_TOOLS_IMAGE=docker.io/cloudflare/sandbox:1.0.0
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM python:3.12-slim
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN pip install --no-cache-dir onnxruntime==1.22.1 tokenizers==0.21.4 numpy==2.3.3
# bardsai/eu-pii-anonimization-multilang (Apache-2.0), pinned revision, int8 ONNX only.
ARG REV=0e72e19f030ed4e661b1673e549af8e0dd176386
ADD https://huggingface.co/bardsai/eu-pii-anonimization-multilang/resolve/${REV}/config.json /model/config.json
ADD https://huggingface.co/bardsai/eu-pii-anonimization-multilang/resolve/${REV}/tokenizer.json /model/tokenizer.json
ADD https://huggingface.co/bardsai/eu-pii-anonimization-multilang/resolve/${REV}/onnx/model_quantized.onnx /model/onnx/model_quantized.onnx
COPY masker.py server.py /app/
WORKDIR /app
EXPOSE 8080
CMD ["python", "-u", "server.py"]
