from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from app.core.config import settings
from app.api.routes.auth import router as auth_router
from app.api.routes.reformat import router as reformat_router
from app.api.routes.billing import router as billing_router, webhook_router
from app.api.routes.profile import profile_router, feedback_router, stats_router

# ── Request Size Limit Middleware ─────────────────────────────────
class RequestSizeLimitMiddleware(BaseHTTPMiddleware):
    """Enforces a hard limit on request body size to prevent OOM."""
    def __init__(self, app, max_size: int = 10 * 1024 * 1024): # 10MB default
        super().__init__(app)
        self.max_size = max_size

    async def dispatch(self, request: Request, call_next):
        if request.method == "POST":
            content_length = request.headers.get("content-length")
            if content_length and int(content_length) > self.max_size:
                return Response(
                    content="Request entity too large",
                    status_code=413
                )
        
        return await call_next(request)


app = FastAPI(
    title="Synapse API",
    description="Cognitive accessibility backend — profile management, AI proxy, billing.",
    version="0.1.0",
    docs_url="/docs" if settings.APP_ENV == "development" else None,
    redoc_url=None,
)

# 15MB limit to allow for larger base64 docs but prevent OOM
app.add_middleware(RequestSizeLimitMiddleware, max_size=15 * 1024 * 1024)

# ── CORS ──────────────────────────────────────────────────────────
# In production, we restrict to the specific extension ID or a regex of allowed origins.
# If neither is provided, we fall back to development-friendly broad origins ONLY if APP_ENV is development.
_allowed_origins = settings.allowed_origins_list
if settings.APP_ENV != "development" and not settings.ALLOWED_ORIGIN_REGEX and "*" in _allowed_origins:
    # Safety: do not allow wildcard in production without explicit regex/ID guard
    _allowed_origins = [o for o in _allowed_origins if o != "*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_origin_regex=settings.allowed_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routes ────────────────────────────────────────────────────────
app.include_router(auth_router,      prefix="/api/v1")
app.include_router(reformat_router,  prefix="/api/v1")
app.include_router(billing_router,   prefix="/api/v1")
app.include_router(webhook_router,   prefix="/api/v1")
app.include_router(profile_router,   prefix="/api/v1")
app.include_router(feedback_router,  prefix="/api/v1")
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import os

# ... rest of imports

# ... after router inclusions
app.include_router(stats_router,     prefix="/api/v1")


@app.get("/health")
async def health():
    return {"status": "ok", "env": settings.APP_ENV}


# ── Static Files (Frontend) ───────────────────────────────────────
# NOTE: the SPA catch-all below matches "/{full_path:path}", so it must be
# registered AFTER every real route (like /health) or it will shadow them.
static_path = os.path.join(os.path.dirname(__file__), "..", "static")
if os.path.exists(static_path):
    # Mount assets folder for static files (css, js)
    assets_path = os.path.join(static_path, "assets")
    if os.path.exists(assets_path):
        app.mount("/assets", StaticFiles(directory=assets_path), name="assets")

    @app.get("/{full_path:path}")
    async def serve_frontend(full_path: str):
        # Allow API calls to proceed
        if full_path.startswith("api/"):
            return Response(status_code=404)
        
        # Check if the requested path is a real file (like favicon.ico)
        file_path = os.path.join(static_path, full_path)
        if os.path.isfile(file_path):
            return FileResponse(file_path)
        
        # Default to index.html for SPA routing
        index_path = os.path.join(static_path, "index.html")
        if os.path.exists(index_path):
            return FileResponse(index_path)
        
        return Response(status_code=404)


# ── API Route Summary ─────────────────────────────────────────────
# POST /api/v1/auth/sync              — upsert user after Google OAuth
# GET  /api/v1/auth/me                — get current user
# POST /api/v1/reformat               — core AI proxy (extension calls this)
# GET  /api/v1/profile                — get cognitive profile
# PATCH /api/v1/profile               — update cognitive profile
# GET  /api/v1/profile/history        — profile change log
# POST /api/v1/feedback               — submit feedback batch
# GET  /api/v1/dashboard/stats        — dashboard stats
# GET  /api/v1/billing/status         — billing status
# POST /api/v1/billing/checkout       — create Stripe checkout session
# POST /api/v1/billing/portal         — open Stripe billing portal
# POST /api/v1/webhooks/stripe        — Stripe webhook handler
