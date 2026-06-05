# Build Stage: Frontend
FROM node:20-slim AS build-frontend
WORKDIR /webpage
COPY webpage/package*.json ./
RUN npm install
COPY webpage/ ./
# Build the frontend - results in /webpage/dist
RUN npm run build

# Final Stage: Backend + Serve Frontend
FROM python:3.11-slim
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy and install Python dependencies
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend code
COPY backend/app ./app

# Copy built frontend assets from build stage to a static folder in backend
COPY --from=build-frontend /webpage/dist ./static

# Set environment variables (Placeholders - should be provided at runtime)
ENV PORT=8000
ENV APP_ENV=production

# Expose the combined port
EXPOSE 8000

# Start the application
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
