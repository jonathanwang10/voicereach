"""
Authentication middleware for JWT validation
Simplified for hackathon per PRD 11.7
"""

from fastapi import Header
from jose import jwt
import logging

logger = logging.getLogger(__name__)

async def get_current_user(authorization: str = Header(None)):
    """
    Get current user from JWT token
    Per PRD: Simplified validation without signature check for hackathon
    """
    try:
        if not authorization:
            # No auth header, use default user (acceptable for hackathon)
            logger.debug("No authorization header, using demo-user")
            return "f76f4e7b-e0aa-45bf-9ebf-f0943365992d"  # Use existing demo user UUID

        # Extract token from Bearer scheme
        if authorization.startswith('Bearer '):
            token = authorization[7:]  # Remove 'Bearer ' prefix
        else:
            token = authorization

        # For hackathon, just decode without full verification (per PRD 12.4)
        try:
            payload = jwt.get_unverified_claims(token)
            user_id = payload.get('sub', 'f76f4e7b-e0aa-45bf-9ebf-f0943365992d')

            # Accept any valid Supabase user ID
            if user_id and len(user_id) > 0:
                return user_id
            else:
                return "f76f4e7b-e0aa-45bf-9ebf-f0943365992d"  # Use existing demo user UUID

        except jwt.JWTError as e:
            logger.debug(f"JWT decode error (using demo-user): {str(e)}")
            return "f76f4e7b-e0aa-45bf-9ebf-f0943365992d"  # Fallback for hackathon

    except Exception as e:
        logger.debug(f"Auth error (using demo-user): {str(e)}")
        return "f76f4e7b-e0aa-45bf-9ebf-f0943365992d"  # Always return a user for hackathon demo