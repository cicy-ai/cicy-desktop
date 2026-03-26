async function forwardJsonRequest(baseUrl, token, requestPath, payload) {
  const response = await fetch(new URL(requestPath, baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error || `Request failed with status ${response.status}`;
    throw new Error(message);
  }

  return data;
}

module.exports = { forwardJsonRequest };
