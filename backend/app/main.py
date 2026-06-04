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
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins_list,
    allow_origin_regex=settings.ALLOWED_ORIGIN_REGEX or None,
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
app.include_router(stats_router,     prefix="/api/v1")


@app.get("/health")
async def health():
    return {"status": "ok", "env": settings.APP_ENV}


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
