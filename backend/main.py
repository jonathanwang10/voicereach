"""
Main FastAPI application for SF Homeless Outreach Voice Transcription App
"""
import os
import json
import asyncio
import httpx
import websockets
from fastapi import FastAPI, HTTPException, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from services.context_service import get_context_service
from starlette.concurrency import run_in_threadpool
from supabase import create_client, Client
from api.auth import verify_token

# Load environment variables
load_dotenv()

app = FastAPI(title="SF Homeless Outreach API", version="0.1.0")

# CORS configuration for hackathon demo
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins for demo
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize Supabase client for context service
supabase_url = os.getenv("SUPABASE_URL")
supabase_key = os.getenv("SUPABASE_SERVICE_KEY")
supabase: Client = create_client(supabase_url, supabase_key)

@app.get("/health")
async def health_check():
    """Simple health check endpoint"""
    return {"status": "ok"}

@app.get("/")
async def root():
    """Root endpoint"""
    return {
        "message": "SF Homeless Outreach API",
        "framework": "FastAPI",
        "project": "sf10x-hackathon",
        "note": "If you see Flask errors, Railway deployed the wrong project!"
    }

async def process_client_message_with_context(message_str: str) -> str:
    """
    Process client message and inject database context if names are detected.

    Args:
        message_str: Raw WebSocket message from client

    Returns:
        Processed message (potentially with context injection)
    """
    try:
        parsed_message = json.loads(message_str)

        # Check if this is a conversation item creation with text content
        if (parsed_message.get("type") == "conversation.item.create" and
            parsed_message.get("item", {}).get("type") == "message"):

            content = parsed_message.get("item", {}).get("content", [])

            # Look for text input content
            for content_item in content:
                if content_item.get("type") == "input_text":
                    text = content_item.get("text", "")
                    print(f"🔍 Analyzing message for names: {text}")

                    # Use context service to get individual context
                    context_service = get_context_service(supabase)
                    context_result = await context_service.get_context_for_message(text)

                    if context_result["context"]:
                        print(f"📊 Found context for {len(context_result['individuals_found'])} individuals")
                        print(f"🏷️ Names detected: {context_result['names_detected']}")

                        # Inject context as a system message before the user message
                        context_message = {
                            "type": "conversation.item.create",
                            "item": {
                                "id": f"context_{parsed_message.get('item', {}).get('id', 'unknown')}",
                                "type": "message",
                                "role": "system",
                                "content": [
                                    {
                                        "type": "input_text",
                                        "text": f"CONTEXT: {context_result['context']}"
                                    }
                                ]
                            }
                        }

                        # Return both the context message and original message as separate messages
                        # We'll need to send them sequentially in the calling code
                        return json.dumps(context_message) + "\n" + message_str

                    else:
                        print("📝 No context found for this message")

        return message_str

    except json.JSONDecodeError:
        print("⚠️ Could not parse message as JSON")
        return message_str
    except Exception as e:
        print(f"❌ Error processing message for context: {str(e)}")
        print(f"📝 Original message will be forwarded without context")
        return message_str

@app.websocket("/api/voice-assistant/realtime/ws")
async def websocket_realtime_proxy(websocket: WebSocket):
    """
    WebSocket proxy for OpenAI Realtime API
    Handles authentication and forwards messages between client and OpenAI
    """
    auth_header = websocket.headers.get("authorization", "")
    token = auth_header[len("Bearer "):] if auth_header.startswith("Bearer ") else ""
    try:
        if not token:
            raise HTTPException(status_code=401)
        await run_in_threadpool(verify_token, token)
    except HTTPException:
        await websocket.close(code=1008)  # policy violation
        return

    print("🔌 WebSocket connection attempt received - GPT Realtime version")
    await websocket.accept()
    print("✅ WebSocket connection accepted")
    
    try:
        # Get OpenAI API key
        api_key = os.getenv("OPENAI_API_KEY")
        print(f"🔑 OpenAI API key available: {'Yes' if api_key else 'No'}")
        if not api_key:
            print("❌ OpenAI API key not configured")
            await websocket.send_text(json.dumps({
                "type": "error",
                "error": {"message": "OpenAI API key not configured"}
            }))
            return
        
        # Create ephemeral token for OpenAI Realtime API
        session_config = {
            "session": {
                "type": "realtime",
                "model": "gpt-realtime",
                # Use audio-only; UI consumes transcript events for text
                "output_modalities": ["audio"],
                "instructions": "You are a specialized AI assistant for homeless outreach workers. Provide BRIEF, ACTIONABLE guidance. Maximum 2-3 sentences per response. Focus on immediate, practical actions. Be direct and specific. Example: Call 911 immediately. Stay 6 feet back. Keep hands visible.",
                "audio": {
                    "input": {
                        "format": {"type": "audio/pcm", "rate": 24000},
                        "turn_detection": {
                            "type": "server_vad",
                            "threshold": 0.5,
                            "silence_duration_ms": 800
                        }
                    },
                    "output": {
                        "format": {"type": "audio/pcm", "rate": 24000},
                        "voice": "alloy",
                    },
                },
            },
        }
        
        # Create ephemeral token
        print("🔑 Creating ephemeral token with OpenAI...")
        
        async with httpx.AsyncClient() as client:
            token_response = await client.post(
                "https://api.openai.com/v1/realtime/client_secrets",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=session_config,
            )
            
            print(f"🔑 Token response status: {token_response.status_code}")
            if not token_response.is_success:
                print(f"❌ Failed to create ephemeral token: {token_response.text}")
                await websocket.send_text(json.dumps({
                    "type": "error",
                    "error": {"message": f"Failed to create ephemeral token: {token_response.text}"}
                }))
                return
            
            token_data = token_response.json()
            ephemeral_key = token_data["value"]
            print("✅ Ephemeral token created successfully")
        
        # Connect to OpenAI Realtime API
        openai_ws_url = f"wss://api.openai.com/v1/realtime?model=gpt-realtime"
        print(f"🔌 Connecting to OpenAI WebSocket: {openai_ws_url}")
        
        # Connect with proper headers
        headers = {
            "Authorization": f"Bearer {ephemeral_key}"
        }
        
        async with websockets.connect(openai_ws_url, extra_headers=headers) as openai_ws:
            print("✅ Connected to OpenAI Realtime API")
            
            # Send session configuration to OpenAI
            session_update = {
                "type": "session.update",
                "session": session_config["session"]
            }
            await openai_ws.send(json.dumps(session_update))
            print("🔧 Session configuration sent to OpenAI")
            
            # Forward messages between client and OpenAI
            async def forward_to_openai():
                try:
                    while True:
                        message = await websocket.receive_text()

                        # Parse the message to check if it's an audio event
                        try:
                            parsed_message = json.loads(message)
                            if parsed_message.get("type") == "input_audio_buffer.append":
                                audio_data = parsed_message.get("audio", "")
                                print(f"🎵 Audio chunk received: {len(audio_data)} characters (expecting base64 PCM)")
                                # No server-side conversion. Ensure client sends 24kHz mono 16-bit PCM base64.
                            elif parsed_message.get("type") == "input_audio_buffer.commit":
                                print("🎵 Audio buffer commit received")
                        except json.JSONDecodeError:
                            print("⚠️ Non-JSON message received")

                        # Process message for context injection
                        processed_message = await process_client_message_with_context(message)

                        # Check if context was injected (indicated by newline separator)
                        if "\n" in processed_message:
                            # Send context message first, then user message
                            context_msg, user_msg = processed_message.split("\n", 1)

                            await openai_ws.send(context_msg)

                            await openai_ws.send(user_msg)
                        else:
                            # Send original message
                            await openai_ws.send(processed_message)
                except websockets.exceptions.ConnectionClosed:
                    print("🔌 OpenAI WebSocket connection closed normally")
                    return
                except Exception as e:
                    print(f"❌ Error forwarding to OpenAI: {e}")
                    return

            async def forward_to_client():
                try:
                    while True:
                        message = await openai_ws.recv()

                        # Parse the message to check for errors
                        try:
                            parsed_message = json.loads(message)
                            if parsed_message.get("type") == "error":
                                error_info = parsed_message.get("error", {})
                                print(f"❌ OpenAI Error: {error_info.get('message', 'Unknown error')}")
                                if error_info.get("code") == "input_audio_buffer_commit_empty":
                                    print("🎵 Audio buffer was empty - this suggests the audio data wasn't received properly")
                        except json.JSONDecodeError:
                            pass

                        await websocket.send_text(message)
                except websockets.exceptions.ConnectionClosed:
                    print("🔌 Client WebSocket connection closed normally")
                    return
                except Exception as e:
                    print(f"❌ Error forwarding to client: {e}")
                    return

            tasks = [asyncio.create_task(forward_to_openai()), asyncio.create_task(forward_to_client())]
            try:
                done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in pending:
                    task.cancel()
            finally:
                try:
                    await openai_ws.close()
                except Exception:
                    pass

    except Exception as e:
        print(f"❌ WebSocket proxy error: {str(e)}")
        try:
            await websocket.send_text(json.dumps({
                "type": "error",
                "error": {"message": f"WebSocket proxy error: {str(e)}"}
            }))
        except:
            pass

# Import API routers
from api import categories, transcription, individuals, embeddings, voice_assistant

# Register routers
app.include_router(categories.router)
app.include_router(transcription.router)
app.include_router(individuals.router, prefix="/api/individuals", tags=["individuals"])
app.include_router(embeddings.router)
app.include_router(voice_assistant.router)
