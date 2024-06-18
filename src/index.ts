import { Hono } from "hono";
import { App } from "octokit";

type Env = {
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
};

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => {
  return c.text("Hello Hono!");
});

app.use("/", async (c, next) => {
  const app = new App({
    appId: c.env.GITHUB_APP_ID,
    privateKey: c.env.GITHUB_PRIVATE_KEY,
    webhooks: {
      secret: c.env.GITHUB_WEBHOOK_SECRET,
    },
  });

  app.webhooks.on("push", async ({ octokit, payload }) => {
    if (payload.repository.owner && payload.ref === "refs/heads/develop") {
      const items = await octokit.rest.pulls.list({
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        state: "open",
        base: "main",
        head: "develop",
      });

      const commits = await octokit.rest.repos.compareCommits({
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        base: "main",
        head: "develop",
      });

      const mergedPrCommits = commits.data.commits.filter((commit) => {
        return /Merge pull request (#\w+) from/.test(commit.commit.message);
      });

      const mergedPr = mergedPrCommits.map((pr) => {
        // biome-ignore lint/style/noNonNullAssertion: <explanation>
        const match = pr.commit.message.match(
          /Merge pull request #(\w+) from/
        )![1];
        return Number.parseInt(match, 10);
      });

      if (items.data.length === 0) {
        await octokit.rest.pulls.create({
          owner: payload.repository.owner.login,
          repo: payload.repository.name,
          title: `Release ${new Date().toUTCString()}`,
          head: "develop",
          base: "main",
          body: mergedPr.map((w) => `- [ ] #${w}`).join("\n"),
        });
      } else {
        const pr = await octokit.rest.pulls.get({
          owner: payload.repository.owner.login,
          repo: payload.repository.name,
          pull_number: items.data[0].number,
        });

        const checked = (pr.data.body ?? "")
          .split("\n")
          .filter((w) => w.startsWith("- [x] #"))
          .map((w) => {
            return w.substring("- [x] #".length);
          });

        await octokit.rest.pulls.update({
          owner: payload.repository.owner.login,
          repo: payload.repository.name,
          pull_number: items.data[0].number,
          body: mergedPr
            .map((w) => {
              return checked.includes(w.toString())
                ? `- [x] #${w}`
                : `- [ ] #${w}`;
            })
            .join("\n"),
        });
      }
    }
  });

  app.webhooks.onError((err) => {
    if (err.name === "AggregateError") {
      console.error(err.message);
    } else {
      console.error(err);
    }
  });

  const event = c.req.header("x-github-event");
  const signature = c.req.header("x-hub-signature-256");
  const id = c.req.header("x-github-delivery");

  if (event && signature && id) {
    const payload = await new Response(c.req.raw.body).text();
    await app.webhooks.verifyAndReceive({
      id,
      // @ts-expect-error
      name: event,
      payload,
      signature,
    });
  }

  return Response.json({ message: "ok" });
});

export default app;
