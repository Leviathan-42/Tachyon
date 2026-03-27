FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 8080
ENV BIND_HOST=0.0.0.0
CMD ["node", "proxy.js"]
