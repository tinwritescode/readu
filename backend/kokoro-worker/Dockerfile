FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# CPU-only torch first, so the package below does not pull the multi-GB CUDA build.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Bake the model and every voicepack into the image so machines start without downloading.
ENV HF_HOME=/app/hf
COPY app.py .
RUN HF_HUB_OFFLINE=0 python -c "import app"
ENV HF_HUB_OFFLINE=1
ENV PORT=8080
CMD ["python", "app.py"]
