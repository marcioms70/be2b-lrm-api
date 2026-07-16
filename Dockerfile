FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache fontconfig ttf-dejavu

COPY package*.json ./

RUN npm install --omit=dev

COPY src ./src
COPY migrations ./migrations

EXPOSE 3000

CMD ["npm", "start"]
