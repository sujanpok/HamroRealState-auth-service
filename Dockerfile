FROM node:18-alpine
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3001
# Add explicit PORT environment variable
ENV PORT=3001
CMD ["npm", "start"]
