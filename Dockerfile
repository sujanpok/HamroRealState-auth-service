# Use ARM64-compatible Node.js base image for Raspberry Pi
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package.json and install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application code (including server.js, routes, etc.)
COPY . .

# Expose the port from env (defaults to 3001 in .env)
EXPOSE 3001

# Run the app as non-root user for security
USER node

# Start the server
CMD ["node", "server.js"]
