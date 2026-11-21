FROM node:20-slim

WORKDIR /app

# Install dependencies first (cached layer)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy application code
COPY . .

# Generate instruction files
RUN bash instructions/generate.sh 2>/dev/null || true

EXPOSE 3030

CMD ["node", "server.js"]
