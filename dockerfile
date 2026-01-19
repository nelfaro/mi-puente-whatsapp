FROM node:20-slim

# Instalamos ffmpeg Y git (que es lo que faltaba)
RUN apt-get update && apt-get install -y ffmpeg git

WORKDIR /app

COPY package*.json ./

# Instalamos las librerías
RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "start"]

