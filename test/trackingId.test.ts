import { expect, test } from "bun:test";
import { hasValidShape, isValid, spell, updateId } from "../server/trackingId";

test("reads a full ID with phonetic letters", () => {
  const text = "B as in Bravo, D as in Delta, four one eight two zero seven";
  expect(updateId("", text)).toBe("BD418207");
});

test("reads an ID spoken as one word", () => {
  expect(updateId("", "it is bd418207")).toBe("BD418207");
});

test("builds the ID over several turns", () => {
  const first = updateId("", "bee dee four one eight");
  expect(first).toBe("BD418");
  expect(updateId(first, "two oh seven")).toBe("BD418207");
});

test("handles double and triple", () => {
  expect(updateId("", "A K double two triple five one")).toBe("AK225551");
});

test("oh is a letter in the first two positions and a zero after", () => {
  expect(updateId("", "oh k one two three four five six")).toBe("OK123456");
});

test("ignores extra speech past eight characters", () => {
  expect(updateId("BD418207", "nine nine")).toBe("BD418207");
});

test("ignores words that are not part of an ID", () => {
  expect(updateId("BD41", "yes that's right")).toBe("BD41");
});

test("corrects one letter: B as in Bravo, not D", () => {
  expect(updateId("DD418207", "no, B as in Bravo, not D")).toBe("BD418207");
});

test("corrects one digit: zero not nine", () => {
  expect(updateId("BD418297", "it's zero not nine")).toBe("BD418207");
});

test("corrects by position", () => {
  expect(updateId("BD418207", "the third digit is 9")).toBe("BD419207");
});

test("a correction for something not in the ID changes nothing", () => {
  expect(updateId("BD418207", "no, Z not Q")).toBe("BD418207");
});

test("validates the format", () => {
  expect(isValid("BD418207")).toBe(true);
  expect(isValid("BD41820")).toBe(false);
  expect(isValid("4D418207")).toBe(false);
});

test("spells the ID for reading back", () => {
  expect(spell("BD418207")).toBe("B as in Bravo, D as in Delta, 4 1 8 2 0 7");
  expect(spell("BD41")).toBe("B as in Bravo, D as in Delta, 4 1");
  expect(spell("B")).toBe("B as in Bravo");
});

test("spells whatever characters it has, even a partial ID", () => {
  expect(spell("BD")).toBe("B as in Bravo, D as in Delta");
  expect(spell("B")).toBe("B as in Bravo");
  expect(spell("D4182")).toBe("D as in Delta, 4 1 8 2");
});

test("knows when characters can no longer become a valid ID", () => {
  expect(hasValidShape("")).toBe(true);
  expect(hasValidShape("BD41")).toBe(true);
  expect(hasValidShape("B")).toBe(true);
  expect(hasValidShape("418")).toBe(false);
  expect(hasValidShape("D4182")).toBe(false);
  expect(hasValidShape("BD41A")).toBe(false);
});

test("background chatter does not leak into the ID", () => {
  expect(updateId("", "I will be there in one hour")).toBe("");
  expect(updateId("BD41", "yeah I know a few minutes more")).toBe("BD41");
  expect(updateId("BD41", "did you see the game last night")).toBe("BD41");
});

test("an ID with talk around it is still read", () => {
  expect(updateId("", "okay it is B D four one eight two zero seven")).toBe("BD418207");
  expect(updateId("", "um let me see, it's B D 4 1 8 2 0 7")).toBe("BD418207");
  expect(updateId("", "my tracking ID is bee dee four one eight two zero seven")).toBe("BD418207");
});

test("digits spoken clearly inside someone else's talk are still picked up", () => {
  expect(updateId("", "last night he was unbelievable four one eight two zero seven believe the score")).toBe("418207");
});

test("short runs of numbers in ordinary talk are not mistaken for an ID", () => {
  expect(updateId("", "we leave at six and pick up three kids at two")).toBe("");
  expect(updateId("", "the game starts at two zero seven or so")).toBe("");
});

test("the one in the second one is an answer, not a digit", () => {
  expect(updateId("", "the second one")).toBe("");
  expect(updateId("BD41", "the third one please")).toBe("BD41");
  expect(updateId("", "B D four one eight two zero seven")).toBe("BD418207");
});

test("a lone pair of letters is the two letters, common words are not", () => {
  expect(updateId("", "dd")).toBe("DD");
  expect(updateId("", "bd four one eight")).toBe("BD418");
  expect(updateId("", "my tracking id")).toBe("");
  expect(updateId("", "ok")).toBe("");
});
