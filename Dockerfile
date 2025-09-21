FROM node:18-alpine

WORKDIR /app

# ビルド依存を追加（ARM64対応）
RUN apk add --no-cache python3 make g++ gcc bash git

COPY package*.json ./

RUN npm install --production  # 本番用にdevDependenciesを除外（軽量化）

COPY . .

# buildスクリプトがない場合、削除または調整
# RUN npm run build  # 必要なければコメントアウト

#RUN npm install -g serve  # これが必要か確認（静的ファイルサーブ用？）

EXPOSE 80
CMD ["npm", "start"]
