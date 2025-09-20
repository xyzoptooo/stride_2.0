# Use official Node.js LTS image
FROM node:22-alpine

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm install --production

# Copy the rest of the backend code
COPY . .

# Expose the backend port
EXPOSE 4000

# Set environment variables (can be overridden at runtime)
ENV NODE_ENV=production

# Start the backend server
CMD ["node", "index.js"]
