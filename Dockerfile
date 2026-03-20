FROM node:22

# Install system dependencies
RUN apt-get update && apt-get install -y \
    xvfb \
    libgtk-3-0 \
    libnotify4 \
    libnss3 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    libatspi2.0-0 \
    libdrm2 \
    libgbm1 \
    libasound2 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd -m -s /bin/bash electron

# Install electron-rcp globally
RUN npm install -g electron-rcp

# Configure chrome-sandbox
RUN chown root:root /usr/local/lib/node_modules/electron/dist/chrome-sandbox && \
    chmod 4755 /usr/local/lib/node_modules/electron/dist/chrome-sandbox

# Switch to non-root user
USER electron
WORKDIR /home/electron

# Create token file
RUN echo '{"api_token":"your-token-here"}' > /home/electron/global.json

# Set display
ENV DISPLAY=:99

# Expose port
EXPOSE 8101

# Start Xvfb and electron-rpc
CMD Xvfb :99 -screen 0 1024x768x24 & \
    sleep 3 && \
    electron-rpc start && \
    tail -f /home/electron/logs/cicy-desktop.log
