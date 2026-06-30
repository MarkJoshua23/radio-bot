FROM node:20-slim

# Install system ffmpeg package
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci --only=production

COPY . .

CMD [ "npm", "start" ]
