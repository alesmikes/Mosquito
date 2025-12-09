FROM node:20-slim

# Nástroje nutné pro build native modulů (dji-thermal-sdk)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Nejprve závislosti
COPY package*.json ./
RUN npm install --production

# Pak zbytek kódu
COPY . .

ENV PORT=8080

CMD ["node", "server.js"]
