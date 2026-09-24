import logging
import sys
import socket
import asyncio
from time import perf_counter

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, OperationalError, ProgrammingError, SQLAlchemyError
from app.core.config import settings
from app.db.database import engine

# ── Logging ───────────────────────────────────────────────────────
# Nothing configured logging before, so the app's own INFO messages went to
# Python's last-resort handler, which only emits WARNING and above — "support
# ticket filed", "rate limiter degraded" and friends were invisible. Scope a
# handler to the `synapse.*` namespace only, so uvicorn's own loggers keep
# their formatting and access lines aren't duplicated.
_synapse_logger = logging.getLogger("synapse")
if not _synapse_logger.handlers:
    _handler = logging.StreamHandler(sys.stdout)
    _handler.setFormatter(logging.Formatter("%(levelname)s [%(name)s] %(message)s"))
    _synapse_logger.addHandler(_handler)
    _synapse_logger.setLevel(logging.DEBUG if settings.APP_ENV == "development" else logging.INFO)
    _synapse_logger.propagate = False
from app.api.routes.auth import router as auth_router
from app.api.routes.reformat import router as reformat_router
from app.api.routes.billing import router as billing_router, webhook_router
from app.api.routes.profile import profile_router, feedback_router, stats_router
from app.api.routes.support import router as support_router
from app.api.routes.observer import router as observer_router
from app.services.observability import measure_request

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


def _friendly_validation_message(error: dict) -> str:
    location = error.get("loc", [])
    field = ".".join(str(part) for part in location if part != "body") or "request"
    error_type = error.get("type", "")
    context = error.get("ctx") or {}
    input_value = error.get("input")

    if error_type == "string_too_short":
        min_length = context.get("min_length")
        if min_length:
            return f"{field} must be at least {min_length} characters long."
        return f"{field} is too short."

    if error_type == "string_too_long":
        max_length = context.get("max_length")
        if max_length:
            return f"{field} must be at most {max_length} characters long."
        return f"{field} is too long."

    if error_type == "missing":
        return f"{field} is required."

    if error_type == "value_error.email":
        return f"{field} must be a valid email address."

    if error_type == "int_parsing":
        return f"{field} must be a whole number."

    if error_type == "greater_than_equal":
        minimum = context.get("ge")
        if minimum is not None:
            return f"{field} must be greater than or equal to {minimum}."

    if error_type == "less_than_equal":
        maximum = context.get("le")
        if maximum is not None:
            return f"{field} must be less than or equal to {maximum}."

    if input_value is not None:
        return f"{field} is invalid."

    message = error.get("msg")
    if message:
        return f"{field}: {message}"
    return f"{field} is invalid."


@app.exception_handler(RequestValidationError)
async def handle_request_validation_error(request: Request, exc: RequestValidationError):
    errors = exc.errors()
    messages = [_friendly_validation_message(error) for error in errors]
    detail = messages[0] if len(messages) == 1 else "; ".join(messages)

    response = {
        "code": "validation_error",
        "detail": detail,
    }
    if settings.APP_ENV == "development":
        response["errors"] = errors

    return JSONResponse(status_code=422, content=response)


@app.exception_handler(SQLAlchemyError)
async def handle_database_error(request: Request, exc: SQLAlchemyError):
    logger = logging.getLogger("synapse")

    code = "database_error"
    detail = "Something went wrong while reading or writing data."
    status_code = 500

    cause = exc.__cause__ or getattr(exc, "orig", None)
    cause_name = cause.__class__.__name__ if cause is not None else ""
    cause_text = str(cause) if cause is not None else ""

    if isinstance(exc, OperationalError) or "could not connect" in cause_text.lower():
        code = "database_unavailable"
        detail = "The backend database is temporarily unavailable. Please try again."
        status_code = 503
    elif isinstance(exc, (ProgrammingError, DBAPIError)) and (
        cause_name == "UndefinedColumnError"
        or cause_name == "UndefinedTableError"
        or "does not exist" in cause_text.lower()
    ):
        code = "schema_mismatch"
        detail = (
            "The backend schema is out of date for this request. "
            "Please run the latest migrations."
        )
        status_code = 503
    else:
        detail = "The database request failed. Please try again."

    log_message = f"Database error during {request.method} {request.url.path} ({code})"
    if settings.APP_ENV == "development":
        logger.exception(log_message)
    else:
        logger.error(log_message)

    response = {"detail": detail, "code": code}
    if settings.APP_ENV == "development":
        response["cause"] = cause_name or exc.__class__.__name__

    return JSONResponse(status_code=status_code, content=response)


@app.exception_handler(socket.gaierror)
async def handle_dns_resolution_error(request: Request, exc: socket.gaierror):
    logger = logging.getLogger("synapse")
    logger.error("Database host resolution failed during %s %s", request.method, request.url.path)

    return JSONResponse(
        status_code=503,
        content={
            "code": "database_unavailable",
            "detail": "Synapse is temporarily unable to reach its data service. Please check your connection and try again shortly.",
        },
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


async def _warm_database_connection() -> None:
    """Populate the SQLAlchemy pool before the service accepts traffic.

    Neon can take noticeably longer to establish the first TLS/database
    connection after an idle period.  Returning this connection to the pool
    means the first real API request can reuse it instead of making a visitor
    wait for that handshake.  A failed warm-up is logged but does not prevent
    the API from coming online: pool_pre_ping will retry on later requests.
    """
    logger = logging.getLogger("synapse")
    started = perf_counter()

    try:
        async with engine.connect() as connection:
            await connection.execute(text("SELECT 1"))
    except Exception as exc:
        logger.warning(
            "Database warm-up unavailable after %.0f ms (%s); requests will retry normally.",
            (perf_counter() - started) * 1000,
            type(exc).__name__,
        )
    else:
        logger.info("Database connection warmed in %.0f ms.", (perf_counter() - started) * 1000)


@app.on_event("startup")
async def warm_database_on_startup() -> None:
    # Bound startup delay so an unavailable database cannot keep a deployment
    # from becoming reachable forever.  The observed Neon cold connection is
    # about 21 seconds, so 30 seconds still leaves room for a normal wake-up.
    try:
        await asyncio.wait_for(_warm_database_connection(), timeout=30)
    except asyncio.TimeoutError:
        logging.getLogger("synapse").warning(
            "Database warm-up timed out after 30000 ms; requests will retry normally."
        )


@app.on_event("shutdown")
async def close_database_pool() -> None:
    await engine.dispose()


class ObserverTelemetryMiddleware(BaseHTTPMiddleware):
    """Collect bounded request latency and traffic samples for operators."""

    async def dispatch(self, request: Request, call_next):
        return await measure_request(request, call_next)


app.add_middleware(ObserverTelemetryMiddleware)

# ── Routes ────────────────────────────────────────────────────────
app.include_router(auth_router,      prefix="/api/v1")
app.include_router(reformat_router,  prefix="/api/v1")
app.include_router(billing_router,   prefix="/api/v1")
app.include_router(webhook_router,   prefix="/api/v1")
app.include_router(profile_router,   prefix="/api/v1")
app.include_router(feedback_router,  prefix="/api/v1")
app.include_router(support_router,   prefix="/api/v1")
app.include_router(observer_router,  prefix="/api/v1")
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
