// Who this person is to others: a name and a picture, kept in this browser, or GitHub's where they are signed in. Where they have
// said neither, a creature: for a name, the one its first letter starts; for nobody yet, one of their own, by this browser's id.

import { auth } from "./auth.js";
import { workspace } from "./workspace.js";

const PICTURE_KEY = "fettled.picture", WELCOMED_KEY = "fettled.welcomed";
/** How large a picture is kept, square, in pixels: what a badge or a slate shows of it, sharp enough. */
const PICTURE_SIZE = 96;

/** Microsoft's Fluent Emoji (MIT), at a commit: each animal's pictures, read from GitHub as they are wanted. */
const FLUENT = "https://raw.githubusercontent.com/microsoft/fluentui-emoji/1ffb34c752ecf5d402f04cfb4b392c77f57c54bc/assets";
/** The animals it has (Unicode's, less what is not a creature), by the names of their folders there. */
const ANIMALS = [
  "Ant", "Baby chick", "Badger", "Bat", "Bear", "Beaver", "Beetle", "Bird", "Bison", "Black cat", "Blowfish", "Boar", "Bug",
  "Butterfly", "Camel", "Cat", "Cat face", "Chicken", "Chipmunk", "Cockroach", "Cow", "Cow face", "Crab", "Cricket", "Crocodile",
  "Deer", "Dodo", "Dog", "Dog face", "Dolphin", "Donkey", "Dove", "Dragon", "Dragon face", "Duck", "Eagle", "Elephant", "Ewe",
  "Fish", "Flamingo", "Fly", "Fox", "Frog", "Front-facing baby chick", "Giraffe", "Goat", "Goose", "Gorilla", "Guide dog",
  "Hamster", "Hatching chick", "Hedgehog", "Hippopotamus", "Honeybee", "Horse", "Horse face", "Jellyfish", "Kangaroo", "Koala",
  "Lady beetle", "Leopard", "Lion", "Lizard", "Llama", "Lobster", "Mammoth", "Monkey", "Monkey face", "Moose", "Mosquito", "Mouse",
  "Mouse face", "Octopus", "Orangutan", "Otter", "Owl", "Ox", "Oyster", "Panda", "Parrot", "Peacock", "Penguin", "Pig", "Pig face",
  "Polar bear", "Poodle", "Rabbit", "Rabbit face", "Raccoon", "Ram", "Rat", "Rhinoceros", "Rooster", "Sauropod", "Scorpion", "Seal",
  "Service dog", "Shark", "Shrimp", "Skunk", "Sloth", "Snail", "Snake", "Spider", "Spouting whale", "Squid", "Swan", "T-rex",
  "Tiger", "Tiger face", "Tropical fish", "Turkey", "Turtle", "Two-hump camel", "Unicorn", "Water buffalo", "Whale", "Wolf", "Worm",
  "Zebra",
];
const BY_LETTER = new Map();
for (const a of ANIMALS) BY_LETTER.set(a[0], [...(BY_LETTER.get(a[0]) ?? []), a]);
/** Those that do as a name, for someone who has not said theirs. */
const NAMES = ANIMALS.filter((a) => !/[ -]/.test(a));
/** Which of its pictures a creature is: "3d" or "flat". (A setting kept here, not offered yet.) */
const STYLE_KEY = "fettled.creatures";
const hash = (text) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const pick = (list, text) => list[hash(text) % list.length];

/** A creature's picture: an address on GitHub. */
function pictureOf(animal) {
  const flat = read(STYLE_KEY) === "flat", file = animal.toLowerCase().replaceAll(" ", "_");
  return `${FLUENT}/${encodeURIComponent(animal)}/${flat ? `Flat/${file}_flat.svg` : `3D/${file}_3d.png`}`;
}

/** The creature of a name: `{ name, picture }`, one of those its first letter starts (any, where none does), the same for
 *  everyone who sees the name. */
export function creatureOf(name = "") {
  const letter = name.normalize("NFD").match(/[A-Za-z]/)?.[0]?.toUpperCase();
  // (A name that is an animal's is that animal: someone who has said nothing is called after theirs.)
  const animal = ANIMALS.find((a) => a.toLowerCase() === name.trim().toLowerCase()) ?? pick(BY_LETTER.get(letter) ?? ANIMALS, name);
  return { name: animal, picture: pictureOf(animal) };
}

const read = (key) => { try { return localStorage.getItem(key); } catch (_) { return null; } };
const write = (key, value) => { try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch (_) { /* not kept here */ } };
const listeners = [];

export const identity = {
  /** What this person is called: what they said, else who they are on GitHub, else their own creature. */
  name() {
    return workspace.myName() || auth.login() || pick(NAMES, workspace.id);
  },
  /** Whether they have said who they are, here or by signing in. */
  said() {
    return !!(workspace.myName() || auth.signedIn());
  },
  /** Their picture (an address, or the picture itself as a `data:` address); none: their creature is shown. */
  picture() {
    const login = auth.login();
    return read(PICTURE_KEY) ?? (login ? `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?s=88` : null);
  },
  /** Whether the picture is one they gave here (which they can take back), not GitHub's. */
  ownPicture() {
    return read(PICTURE_KEY) != null;
  },
  /** Who this is to others: `{ who, name, picture }`. */
  me() {
    return { who: workspace.id, name: this.name(), picture: this.picture() };
  },
  setName(name) {
    workspace.setMyName(name);
    this.changed();
  },
  /** A picture they chose (a file), kept here small and square; null: none of their own. */
  async setPicture(file) {
    write(PICTURE_KEY, file ? await squared(file) : null);
    this.changed();
  },
  /** Whether they have been asked who they are yet, in this browser. */
  welcomed() {
    return read(WELCOMED_KEY) != null || this.said();
  },
  setWelcomed() {
    write(WELCOMED_KEY, "1");
  },
  /** `f()` whenever who this is changes. */
  onChange(f) { listeners.push(f); },
  changed() { for (const f of listeners) f(); },
};
// (What this person is called, for what they do where it is kept, as they are called here: a host names them by it.)
workspace.nameOf = () => identity.name();

/** A picture made small and square, its middle kept: a `data:` address. */
async function squared(file) {
  const image = await createImageBitmap(file);
  const side = Math.min(image.width, image.height), c = document.createElement("canvas");
  c.width = c.height = PICTURE_SIZE;
  c.getContext("2d").drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, PICTURE_SIZE, PICTURE_SIZE);
  image.close();
  return c.toDataURL("image/jpeg", 0.85);
}
