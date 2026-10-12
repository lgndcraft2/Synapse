"""Content-free signal that someone read a document in the Synapse PDF viewer."""

import logging

from fastapi import APIRouter, Depends, Request, Response, status
from redis.exceptions import RedisError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_optional_user
from app.core.request_utils import client_ip
from app.db.database import get_db
from app.models.models import ViewerOpen
from app.services import rate_limit

logger = logging.getLogger("synapse.viewer")

router = APIRouter(prefix="/viewer", tags=["viewer"])

# Opens per IP per hour before further ones are dropped. Far above real reading,
# low enough that a script can't flood the table.
_OPENS_PER_HOUR = 120


async def _within_limit(request: Request) -> bool:
    key = f"viewer:opens:{client_ip(request)}"
    try:
        count = await rate_limit.redis_client.incr(key)
        if count == 1:
            await rate_limit.redis_client.expire(key, 3600)
    except RedisError as e:
        # A count is not worth failing over; keep it, as the quotas do.
        logger.warning("Viewer open limiter unavailable (%s); recording anyway.", e)
        return True
    return count <= _OPENS_PER_HOUR


@router.post("/opened", status_code=status.HTTP_204_NO_CONTENT)
async def viewer_opened(request: Request, db: AsyncSession = Depends(get_db)):
    """Record one open. Takes no body: no URL, file name or title is sent or kept."""
    if await _within_limit(request):
        user = await get_optional_user(request, db)
        db.add(ViewerOpen(user_id=user.id if user else None))
        await db.flush()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
