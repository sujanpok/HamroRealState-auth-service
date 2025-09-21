FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install --production  # devDependenciesを除外して軽量化

COPY . .

CMD ["npm", "start"]
