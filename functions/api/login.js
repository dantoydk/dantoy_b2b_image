export async function onRequestPost(context) {
  const { request, env } = context;

  const { username, password } = await request.json();

  const storedPassword = await env.B2B_IMAGE_USERS.get(username);

  if (!storedPassword || storedPassword !== password) {
    return new Response("Invalid credentials", { status: 401 });
  }

  const token = await createJWT(
    { user: username },
    env.JWT_SECRET,
    600 // 10 minutes
  );

  return new Response(JSON.stringify({ token }), {
    headers: { "Content-Type": "application/json" }
  });
}