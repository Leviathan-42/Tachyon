FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev 2>/dev/null || true
COPY . .
EXPOSE 8080
CMD ["node", "proxy.js"]
