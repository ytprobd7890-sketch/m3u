FROM node:20-alpine

# Set node environment to production
ENV NODE_ENV=production

# Pre-configure our automatic free Indian Residential proxy (Tor SOCKS5 -> Privoxy HTTP)
ENV INDIAN_PROXY="http://127.0.0.1:8118"

# Install Tor and Privoxy packages
RUN apk add --no-cache tor privoxy

# Create app directory
WORKDIR /usr/src/app

# Copy package, server, and favorite channels configuration files
COPY package.json ./
COPY server.js ./
COPY allowed_247_channels.json ./

# Configure Tor (Enforce SOCKS5 on 9050, route only through Indian Exit Nodes)
RUN mkdir -p /var/lib/tor && chmod -R 700 /var/lib/tor && \
    echo "ExitNodes {in}" >> /etc/tor/torrc && \
    echo "StrictNodes 1" >> /etc/tor/torrc && \
    echo "SocksPort 127.0.0.1:9050" >> /etc/tor/torrc && \
    echo "DataDirectory /var/lib/tor" >> /etc/tor/torrc && \
    echo "User tor" >> /etc/tor/torrc

# Configure Privoxy (Convert SOCKS5 Tor proxy to standard HTTP Proxy on Port 8118)
RUN echo "forward-socks5t / 127.0.0.1:9050 ." >> /etc/privoxy/config && \
    echo "listen-address 127.0.0.1:8118" >> /etc/privoxy/config && \
    sed -i 's/toggle 1/toggle 0/g' /etc/privoxy/config || true

# Create cache directory and grant permissions
RUN mkdir -p cache_segments && chmod -R 777 cache_segments

# Expose default port
EXPOSE 8080

# Start Tor, Privoxy, and our Caching Server concurrently
CMD tor --RunAsDaemon 1 && privoxy /etc/privoxy/config && node server.js
