FROM node:20-alpine

# Set node environment to production
ENV NODE_ENV=production

# Create app directory
WORKDIR /usr/src/app

# Copy package.json
COPY package.json ./

# Copy server code
COPY server.js ./

# Create cache directory and grant permissions
RUN mkdir -p cache_segments && chmod -R 777 cache_segments

# Expose default port
EXPOSE 8080

CMD [ "node", "server.js" ]
