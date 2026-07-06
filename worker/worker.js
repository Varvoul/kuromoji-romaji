const VERCEL_URL = "https://kuromoji-romaji.vercel.app";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Root path - health check
    if (url.pathname === "/") {
      return new Response("Romaji converter is running", {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    // Convert endpoint
    if (url.pathname === "/convert") {
      const text = url.searchParams.get("text");

      if (!text) {
        return new Response(
          JSON.stringify({ error: "Missing text parameter" }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      try {
        const proxyUrl = `${VERCEL_URL}/api/convert?text=${encodeURIComponent(text)}`;
        const response = await fetch(proxyUrl);

        if (!response.ok) {
          return new Response(
            JSON.stringify({ error: "Conversion failed" }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        const data = await response.json();
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        console.error("Proxy error:", err);
        return new Response(
          JSON.stringify({ error: "Conversion failed" }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    // 404 for other paths
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
};