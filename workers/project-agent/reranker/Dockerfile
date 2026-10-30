# The platform's exec/file plumbing (sandbox-shim) - same donor image as the agent sandbox.
ARG SANDBOX_TOOLS_IMAGE=docker.io/cloudflare/sandbox:1.0.0
FROM ${SANDBOX_TOOLS_IMAGE} AS sandbox-tools

FROM python:3.12-slim
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN pip install --no-cache-dir onnxruntime==1.22.1 tokenizers==0.21.4 numpy==2.3.3
# BAAI/bge-reranker-v2-m3 (Apache-2.0) as int8 ONNX (onnx-community), pinned revision.
ARG REV=6f5ff65298512715a1e669753bc754d2bc8f367b
ADD https://huggingface.co/onnx-community/bge-reranker-v2-m3-ONNX/resolve/${REV}/config.json /model/config.json
ADD https://huggingface.co/onnx-community/bge-reranker-v2-m3-ONNX/resolve/${REV}/tokenizer.json /model/tokenizer.json
ADD https://huggingface.co/onnx-community/bge-reranker-v2-m3-ONNX/resolve/${REV}/onnx/model_int8.onnx /model/onnx/model_int8.onnx
COPY rerank.py server.py /app/
WORKDIR /app
EXPOSE 8080
CMD ["python", "-u", "server.py"]
