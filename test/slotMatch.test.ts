import { expect, test } from "bun:test";
import { hourNamed } from "../server/slotMatch";

test("spoken times become hours, and a bare number word is not a time", () => {
  const cases: [string, number | undefined][] = [
    ["4 pm", 16], ["4pm", 16], ["4 p.m.", 16], ["four o'clock", 16], ["at four", 16], ["four to six", 16],
    ["9 to 11", 9], ["10 a.m.", 10], ["16:00", 16], ["ten thirty", 10], ["12 am", 0],
    ["the evening one", undefined], ["that one please", undefined], ["morning", undefined],
  ];
  for (const [text, hour] of cases) expect([text, hourNamed(text)]).toEqual([text, hour]);
});
