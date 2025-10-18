FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

# CRITICAL: Set PORT explicitly
ENV PORT=3001
EXPOSE 3001

CMD ["npm", "start"]
