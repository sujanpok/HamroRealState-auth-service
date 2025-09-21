FROM node:18-alpine

# Install build tools for native dependencies (required on Alpine ARM64)
RUN apk add --no-cache --virtual .build-deps \
        python3 \
        make \
        g++ \
        libc-dev \
        && python3 -m ensurepip \
        && pip3 install --no-cache --upgrade pip setuptools wheel

WORKDIR /app

COPY package*.json ./

# Install dependencies reproducibly (fixes potential lockfile issues)
RUN npm ci --verbose

# Copy app and build for production
COPY . .
RUN npm run build  # Remove if your app doesn't need this (e.g., no dist folder)

# Clean up to keep image small
RUN apk del .build-deps

EXPOSE 80
CMD ["node", "server.js"]
