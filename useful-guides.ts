import { glob } from "glob";
import { getState, writeState } from "./utils/state";
import { resolve, sleep } from "bun";
import { parse as parseYAML } from "yaml";
import { DiscordMessage, discordFetch } from "./utils/discord";

const stateChannelID = process.env.STATE_CHANNEL_ID;
if (!stateChannelID) {
  throw new Error("STATE_CHANNEL_ID is not set");
}

const guideChannelID = process.env.GUIDE_CHANNEL_ID;
if (!guideChannelID) {
  throw new Error("GUIDE_CHANNEL_ID is not set");
}

type State = {
  // {(m)essage ID, (c)omment IDs}
  [messageFile: string]: { m: string; c?: string[] };
};

type UsefulGuide = {
  title: string;
  content: string;
  comments?: string[];
  reset?: boolean;
};

let { state, messageID } = await getState<State>(
  stateChannelID,
  process.env.GUIDE_STATE || ""
);

// Setup defaults...
state = {
  ...state,
};

const messageFiles = process.argv[2]
  ? [process.argv[2]]
  : await glob("useful-guides/**/*.yaml");

const syncExistingPost = async (
  content: string,
  messageID: string,
  commentID?: string
) => {
  // Get current content:
  const url = `/channels/${messageID}/messages/${
    commentID ? commentID : messageID
  }`;

  const response: DiscordMessage = await discordFetch(url);
  const currentContent = response.content;

  // Update content if needed:
  if (currentContent !== content) {
    console.log(
      `-- Updating existing ${commentID ? "message comment" : "forum post"}...`
    );
    await discordFetch(url, {
      method: "PATCH",
      body: JSON.stringify({
        content,
      }),
    });
  }

  await sleep(2000);
};

const createNewPost = async (data: UsefulGuide): Promise<string> => {
  console.log("-- Creating new post...");

  const response: DiscordMessage = await discordFetch(
    `/channels/${guideChannelID}/threads`,
    {
      method: "POST",
      body: JSON.stringify({
        name: data.title,
        message: {
          content: data.content,
        },
      }),
    }
  );

  await sleep(2000);
  return response.id;
};

const createNewComment = async (
  data: string,
  postID: string
): Promise<string> => {
  console.log("-- Creating new comment...");

  const response: DiscordMessage = await discordFetch(
    `/channels/${postID}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        content: data,
      }),
    }
  );

  await sleep(2000);
  return response.id;
};

const syncComments = async (
  data: Required<UsefulGuide>,
  messageID: string,
  commentIDs: string[]
): Promise<string[]> => {
  for (const [index, comment] of data.comments.entries()) {
    if (commentIDs[index] !== undefined) {
      // console.log("-- WOULD SYNC EXISTING COMMENT", {
      //   index,
      //   commentID: commentIDs[index],
      // });
      await syncExistingPost(comment, messageID, commentIDs[index]);
    } else {
      // console.log("-- WOULD CREATE NEW COMMENT", {
      //   index,
      //   commentID: commentIDs[index],
      // });
      commentIDs[index] = await createNewComment(comment, messageID);
    }
  }

  return commentIDs;
};

try {
  for (const messageFile of messageFiles) {
    const key =
      messageFile.split("/").pop()?.replace(".yaml", "") || messageFile;
    const file = Bun.file(messageFile);
    const fileContents = await file.text();
    const data: UsefulGuide = parseYAML(fileContents);

    if (data.reset) {
      console.info(`Resetting ${messageFile} state...`);
      state[key] = { m: "" };
    }

    console.info(`Processing ${messageFile}...`);

    state[key] = state[key] || { m: "" };

    if (state[key].m) {
      await syncExistingPost(data.content, state[key].m);
    } else {
      state[key].m = await createNewPost(data);
    }

    if (data.comments !== undefined) {
      state[key].c = await syncComments(
        data as any,
        state[key].m,
        state[key].c || []
      );
    }
  }
} finally {
  await writeState(stateChannelID, messageID, state);
}
