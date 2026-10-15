// Thin client for the Flask JSON API. Every unsafe request carries the CSRF token from the page.

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const FALLBACK = {
  0: "Can't reach the server. Check your connection and try again.",
  400: "The request was not accepted. Refresh the page and try again.",
  404: "That item no longer exists.",
  413: "That upload is too large.",
  500: "Something went wrong on the server. Please try again.",
};

export function createApi({ fetchFn, csrfToken }) {
  async function request(path, { method = "GET", json, body } = {}) {
    const headers = {};
    if (method !== "GET") headers["X-CSRFToken"] = csrfToken();
    let payload = body;
    if (json !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(json);
    }

    let response;
    try {
      response = await fetchFn(path, { method, headers, body: payload, credentials: "same-origin" });
    } catch {
      throw new ApiError(FALLBACK[0], 0);
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      /* non-JSON body (e.g. a proxy error page) */
    }
    if (!response.ok) {
      const message = (data && typeof data.error === "string" && data.error) ||
        FALLBACK[response.status] || `The server returned an error (HTTP ${response.status}).`;
      throw new ApiError(message, response.status);
    }
    if (data === null) throw new ApiError("The server returned an unreadable response.", response.status);
    return data;
  }

  return {
    listConversations: async () => (await request("/api/conversations")).conversations,
    getConversation: (id) => request(`/api/conversations/${encodeURIComponent(id)}`),
    renameConversation: (id, title) => request(`/api/conversations/${encodeURIComponent(id)}`, { method: "PATCH", json: { title } }),
    deleteConversation: (id) => request(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }),

    /** Sends text and optional images as multipart form data (the format /api/chat accepts for images). */
    sendMessage({ message, conversationId, files = [] }) {
      const form = new FormData();
      form.append("message", message);
      if (conversationId) form.append("conversation_id", conversationId);
      for (const file of files) form.append("images", file, file.name);
      return request("/api/chat", { method: "POST", body: form });
    },
  };
}
