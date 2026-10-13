FROM node:20-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
RUN mkdir -p /app/data
ENV PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
CMD ["node", "server.js"]
