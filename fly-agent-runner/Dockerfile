FROM node:22-slim

# Install git (needed for clone/branch/push) and Claude Code CLI
RUN apt-get update && apt-get install -y git curl && \
    npm install -g @anthropic-ai/claude-code && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy source
COPY . .

# Create repos cache directory
RUN mkdir -p /repos

EXPOSE 8080

CMD ["node", "server.js"]
