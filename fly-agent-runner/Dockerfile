FROM node:22-slim

# Install git, curl, python3 (for gcloud), and Claude Code CLI
RUN apt-get update && apt-get install -y git curl python3 apt-transport-https gnupg && \
    npm install -g @anthropic-ai/claude-code && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Google Cloud CLI
RUN curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" > /etc/apt/sources.list.d/google-cloud-sdk.list && \
    apt-get update && apt-get install -y google-cloud-cli && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm install --legacy-peer-deps --omit=dev

# Copy source
COPY . .

# Create repos cache directory and gcloud config dir
RUN mkdir -p /repos /root/.config/gcloud

EXPOSE 8080

CMD ["node", "server.js"]
