import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { Octokit } from "@octokit/core";
import * as duckdb from 'duckdb';
import crypto from 'crypto';
import path from 'path';
import {
  createAckEvent,
  createDoneEvent,
  createErrorsEvent,
  createTextEvent,
  getUserMessage,
  prompt,
  verifyAndParseRequest,
} from "@copilot-extensions/preview-sdk";

function getUserDBPath(username) {
  const hash = crypto
    .createHash('sha256')
    .update(username)
    .digest('hex')
    .slice(0, 16);
  return path.join('/tmp', `duckdb_${hash}.db`);
}

// Initialize DuckDB - these will be set per user session
let db;
let connection;

// Helper function to execute SQL queries
async function executeQuery(query) {
  return new Promise((resolve, reject) => {
    connection.all(query, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

// Results with printTable(json);
async function executeQueryPretty(query) {
  return new Promise((resolve, reject) => {
    connection.all(query, (err, result) => {
      if (err) {
        reject(err);
      } else {
        // Print the SQL query within ```sql tags
        const chunks = ['```sql\n', query, ' \n', '```\n', '\n'];
        const p = new Table(result);
        const tableStr = p.render();
        chunks.push('```\n');
        chunks.push(tableStr.toString());
        chunks.push('```\n');
        resolve(chunks);
      }
    });
  });
}

// Helper function to execute SQL queries
async function executeQueryTable(query) {
  return new Promise((resolve, reject) => {
    connection.all(query, (err, result) => {
      if (err) {
        reject(err);
      } else {
        const chunks = [];
        if (result.length > 0) {
          const headers = Object.keys(result[0]);
          chunks.push('| ' + headers.join(' | ') + ' |\n');
          chunks.push('| ' + headers.map(() => '---').join(' | ') + ' |\n');
          result.forEach(row => {
            const values = headers.map(header => row[header]);
            chunks.push('| ' + values.join(' | ') + ' |\n');
          });
          chunks.push('\n');
        } else {
          chunks.push('Ok. No results returned.\n');
        }
        resolve(chunks);
      }
    });
  });
}

// Dummy helper to filter out non-queries
function containsSQLQuery(message) {
  const duckdbPattern = /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|COPY|ATTACH|FROM|WHERE|GROUP BY|ORDER BY|LIMIT|READ_CSV|READ_PARQUET|READ_JSON_AUTO|UNNEST|PRAGMA|EXPLAIN|DESCRIBE|SHOW|SET|WITH|CASE|JOIN|TABLE)\b/i;
  return duckdbPattern.test(message.toUpperCase());
}

const app = new Hono();

app.get("/", (c) => {
  return c.text("Quack! 👋");
});

app.post("/", async (c) => {
  const tokenForUser = c.req.header("X-GitHub-Token") ?? "";
  const body = await c.req.text();
  const signature = c.req.header("github-public-key-signature") ?? "";
  const keyID = c.req.header("github-public-key-identifier") ?? "";
  const { isValidRequest, payload } = await verifyAndParseRequest(
    body,
    signature,
    keyID,
    {
      token: tokenForUser,
    }
  );

  if (!isValidRequest) {
    console.error("Request verification failed");
    c.header("Content-Type", "text/plain");
    c.status(401);
    return c.text("Request could not be verified");
  }

  if (!tokenForUser) {
    return c.text(
      createErrorsEvent([
        {
          type: "agent",
          message: "No GitHub token provided in the request headers.",
          code: "MISSING_GITHUB_TOKEN",
          identifier: "missing_github_token",
        },
      ])
    );
  }

  c.header("Content-Type", "text/html");
  c.header("X-Content-Type-Options", "nosniff");

  return stream(c, async (stream) => {
    try {
      stream.write(createAckEvent());
      const octokit = new Octokit({ auth: tokenForUser });
      const user = await octokit.request("GET /user");

      // Initialize database for this user if not already done
      if (!db) {
        const dbPath = getUserDBPath(user.data.login);
        console.log(`Initializing database at ${dbPath}`);
        db = new duckdb.Database(dbPath);
        connection = db.connect();
      }

      const userPrompt = getUserMessage(payload);

      // Check if the message contains a SQL query
      if (containsSQLQuery(userPrompt)) {
        console.log(user.data.login, userPrompt);
        try {
          const resultChunks = await executeQueryTable(userPrompt);
          console.log('Query Output:', resultChunks.join());
          for (const chunk of resultChunks) {
            stream.write(createTextEvent(chunk));
          }
        } catch (error) {
          // not a query, lets work around it
          console.log(`Not a query! guessing via prompt.`);
          const { message } = await prompt(`You are a DuckDB SQL Expert. Return a DuckDB SQL query for this prompt. do not add any comments - only pure DuckDB SQL allowed: ${userPrompt}`, {
            token: tokenForUser,
          });
          const stripSQL = message.content.split('\n').filter(line => !line.trim().startsWith('```') && line.trim() !== '').join() || message.content;
          console.log('LLM Output:', stripSQL);
          if (containsSQLQuery(stripSQL)) {
            try {
              const resultChunks = await executeQueryTable(stripSQL);
              console.log('Query Output:', resultChunks.join());
              for (const chunk of resultChunks) {
                stream.write(createTextEvent(chunk));
              }
            } catch (error) {
              stream.write(createTextEvent(`Oops! ${error}`));
            }
          }
        }
      } else {
        // Handle non-SQL messages using the normal prompt flow
        console.log(`not a query. guessing via prompt.`);
        const { message } = await prompt(userPrompt, {
          token: tokenForUser,
        });
        console.log('LLM Output:', message.content);
        stream.write(createTextEvent(message.content));
      }
      
      stream.write(createDoneEvent());
      
    } catch (error) {
      stream.write(
        createErrorsEvent([
          {
            type: "agent",
            message: error instanceof Error ? error.message : "Unknown error",
            code: "PROCESSING_ERROR",
            identifier: "processing_error",
          },
        ])
      );
    }
  });
});

const port = 3000;
console.log(`Server is running on port ${port}`);

serve({
  fetch: app.fetch,
  port,
});
