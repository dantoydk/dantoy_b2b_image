import { createJWT } from "../lib/jwt";

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();

    const username = body.username?.toLowerCase();
    const password = body.password;

    if (!username || !password) {
      return new Response("Missing username or password", { status: 400 });
    }

    const storedPassword = await env.B2B_IMAGE_USERS.get(username);

    if (!storedPassword || storedPassword !== password) {
      return new Response("Invalid credentials", { status: 401 });
    }

    // ✅ 10 minutes
    const expiresIn = 600;
    const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;

    const token = await createJWT(
      { user: username },
      env.JWT_SECRET,
      expiresIn
    );

    return new Response(JSON.stringify({
      token,
      expires_in: expiresIn,
      expires_at: expiresAt
    }), {
      headers: {
        "Content-Type": "application/json"
      }
    });

  } catch (err) {
    console.error("LOGIN ERROR:", err);
    return new Response("Invalid request body", { status: 400 });
  }
}