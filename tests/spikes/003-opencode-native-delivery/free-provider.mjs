export default {
  id: "relay-isolated-free-provider",
  async setup(ctx) {
    const { baseURL, route, contextTokens, outputTokens, tools = false } = ctx.options;
    const url = new URL(baseURL);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["free", "openrouter/free", "kilo-auto/free"].includes(route) ||
      !Number.isSafeInteger(contextTokens) ||
      contextTokens < 1 ||
      !Number.isSafeInteger(outputTokens) ||
      outputTokens < 1 ||
      typeof tools !== "boolean"
    )
      throw new Error("Invalid isolated free provider");
    const providerID = "relay-free-probe";
    const registration = await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          id: providerID,
          name: "Isolated free inference",
          activation: "enabled",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL, apiKey: "not-required", timeout: 45000, maxTokens: 1024 },
        },
        models: [
          {
            id: route,
            modelID: route,
            providerID,
            name: route,
            capabilities: { tools, input: ["text"], output: ["text"] },
            variants: [],
            time: { released: 0 },
            cost: [],
            status: "active",
            enabled: true,
            limit: { context: contextTokens, output: outputTokens },
            settings: { maxTokens: 1024, timeout: 45000 },
          },
        ],
      });
    });
    let retry;
    const cleanup = async () => {
      const errors = [];
      try {
        await retry?.dispose();
      } catch (error) {
        errors.push(error);
      }
      try {
        await registration.dispose();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Free provider cleanup failed");
    };
    try {
      retry = await ctx.session.hook("retry", (event) => {
        if (event.model?.providerID !== providerID) return;
        const retryable =
          event.error?.type === "provider.rate-limit" ||
          [429, 502, 503, 504].includes(event.error?.status);
        event.decision =
          retryable && event.attempt < 3
            ? { retry: true, delay: 2000 * event.attempt }
            : { retry: false };
      });
    } catch (error) {
      try {
        await cleanup();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Free provider setup and cleanup failed");
      }
      throw error;
    }
    return cleanup;
  },
};
