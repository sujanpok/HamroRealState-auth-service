FROM node:18-alpine

# Install dependencies for building native modules
RUN apk add --no-cache python3 g++ make

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN npm run build
RUN npm install -g serve

EXPOSE 80
CMD ["serve", "-s", "dist", "-l", "80"]
