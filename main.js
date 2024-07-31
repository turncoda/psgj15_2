"use strict";

const ONE_OVER_SQRT_OF_TWO = 1.0 / Math.sqrt(2.0);
const TARGET_FRAME_RATE = 60.0; // frames per second
const TARGET_FRAME_DURATION = 1000.0 / TARGET_FRAME_RATE; // milliseconds

const CHARSET_TILE_SIZE = 16;
const CHARSET_TILE_WIDTH = 10;
const CHARSET_TILE_HEIGHT = 16;
const TILE_SIZE = 16;
const SCREEN_WIDTH = 320;
const SCREEN_HEIGHT = 180;

const VerticalAlignment = Object.freeze({
  TOP: Symbol("top"),
  CENTER: Symbol("center"),
  BOTTOM: Symbol("bottom"),
});

const HorizontalAlignment = Object.freeze({
  LEFT: Symbol("left"),
  CENTER: Symbol("center"),
  RIGHT: Symbol("right"),
});

let gl;
let buffer_unit_rect;
let buffer_debug;
let buffer_debug_length;

let ldtk_map;
let img_spritesheet;
let charset;
let fb;
let shader_programs = {};
let spritesheet_json;
const entity_data = {};
const g_levels = [];
const text_boxes = [];
const animated_sprites = [];
let indicator;
let g_level_name;
let g_level;
let pause_text_box;
let interact_text_box;

let prev_timestamp = 0;
let time_since_last_draw = 0;

let player;
const player_inventory = [];
let player_inventory_index = -1;
let player_sprite_x, player_sprite_y;
const PLAYER_LOW_SPEED = 0.5;
const PLAYER_HIGH_SPEED = 1.5;
const PLAYER_DASH_SPEED = 2.4;
let player_velocity = 0;
let player_velocity_target = 0;
const PLAYER_VELOCITY_MAX_INCREMENT = .1;
const PLAYER_VELOCITY_MAX_DECREMENT = .05;
let player_light_sensors;
let player_shadow_level;
let player_light_level;
const PLAYER_MAX_LIGHT_LEVEL = 3000; // milliseconds
let player_dash_counter = 0;
let player_can_dash = false;
const PLAYER_DASH_MAX_DURATION = 500;
let targeted_entity;
let checkpoint_x;
let checkpoint_y;
let checkpoint_level_name;
const func_queue = [];
let is_pressed_up = false;
let is_pressed_left = false;
let is_pressed_down = false;
let is_pressed_right = false;
let is_pressed_dash = false;
let is_pressed_interact = false;
let try_interact = false;
let player_is_dashing = false;
let is_debug_vis = false;
let is_paused = false;
let is_frozen = false;
let is_night = false;
let is_plant_watered = false;
let is_player_upgraded = false;

function hideText() {
  interact_text_box.visible = false;
}
function makeFuncShowText(text) {
  return () => {
    interact_text_box.text = text;
    interact_text_box.visible = true;
  };
}
function makeFuncCompose(f, g) {
  return () => {
    f();
    g();
  };
}

class Level {
  constructor(x, y, w, h, ei, tr, ti, iw) {
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
    this.entity_instances = ei;
    this.triggers = tr;
    this.tiles = ti;
    this.invisible_walls = iw;
  }
}

class TextBox {
  constructor(text, x, y, max_chars_per_line, horizontal_alignment, vertical_alignment) {
    this.visible = true;
    this._text = text;
    this.x = Math.round(x);
    this.y = Math.round(y);
    this.horizontal_alignment = horizontal_alignment;
    this.vertical_alignment = vertical_alignment;
    this.max_chars_per_line = max_chars_per_line ??
      SCREEN_WIDTH / CHARSET_TILE_WIDTH;
  }

  get text() {
    return this._text;
  }

  set text(t) {
    this._text = t;
    this._cached_lines = undefined;
  }

  splitTextIntoLines() {
    if (this._cached_lines) return this._cached_lines;
    this._cached_lines = [];
    let line = "";
    for (const word of this.text.split(" ")) {
      if (line.length + 1 + word.length > this.max_chars_per_line) {
        if (line.length > 0) this._cached_lines.push(line);
        line = "";
      }
      line = line.length === 0 ? word : [line, word].join(" ");
    }
    this._cached_lines.push(line);
    return this._cached_lines;
  }

  width() {
    return this.max_chars_per_line * CHARSET_TILE_WIDTH;
  }

  leftX() {
    const width = this.width();
    let x;
    switch (this.horizontal_alignment) {
      default:
      case HorizontalAlignment.LEFT:
      x = this.x;
      break;
      case HorizontalAlignment.CENTER:
      x = this.x - width / 2;
      break;
      case HorizontalAlignment.RIGHT:
      x = this.x - width;
      break;
    }
    return x;
  }

  topY() {
    const lines = this.splitTextIntoLines();
    const height = CHARSET_TILE_HEIGHT * lines.length;
    let y;
    switch (this.vertical_alignment) {
      default:
      case VerticalAlignment.TOP:
      y = this.y;
      break;
      case VerticalAlignment.CENTER:
      y = this.y - height / 2;
      break;
      case VerticalAlignment.BOTTOM:
      y = this.y - height;
      break;
    }
    return y;
  }

  bgRect() {
    const lines = this.splitTextIntoLines();
    const height = CHARSET_TILE_HEIGHT * lines.length;
    const width = this.width();
    const x = this.leftX();
    const y = this.topY();
    return new Rect(x, y, width, height);
  }

  // returns an array of src rects and and array of dst rects
  charRects() {
    const lines = this.splitTextIntoLines();
    const result = [];
    for (let y = 0; y < lines.length; y++) {
      const line = lines[y];
      for (let x = 0; x < line.length; x++) {
        const c = line.charCodeAt(x);
        const sx = c % 16 * CHARSET_TILE_WIDTH;
        const sy = Math.trunc(c / 16) * CHARSET_TILE_HEIGHT;
        const s = new Rect(
          sx,
          sy,
          CHARSET_TILE_WIDTH,
          CHARSET_TILE_HEIGHT,
        );
        const width = this.width();
        const ox = this.leftX();
        const oy = this.topY();
        const d = new Rect(
          ox + x * CHARSET_TILE_WIDTH,
          oy + y * CHARSET_TILE_HEIGHT,
          CHARSET_TILE_WIDTH,
          CHARSET_TILE_HEIGHT);
        result.push([s, d]);
      }
    }
    return result;
  }
}

class Rect {
  constructor(x, y, w, h) {
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
  }
  copy() {
    return new Rect(this.x, this.y, this.w, this.h);
  }
  test(o) {
    return !(
      this.x > o.x + o.w ||
      this.y > o.y + o.h ||
      this.x + this.w < o.x ||
      this.y + this.h < o.y
    );
  }
  xDistTo(o, epsilon) {
    let a = this;
    let b = o;
    let flip = 1;
    if (b.x < a.x) [a, b, flip] = [b, a, -1];
    return flip * (b.x - (a.x + a.w) - epsilon);
  }
  yDistTo(o, epsilon) {
    let a = this;
    let b = o;
    let flip = 1;
    if (b.y < a.y) [a, b, flip] = [b, a, -1];
    return flip * (b.y - (a.y + a.h) - epsilon);
  }
  centroid() {
    return [this.x + this.w / 2, this.y + this.h / 2];
  }
}

class Entity {
  constructor(identifier, x, y, data) {
    this.identifier = identifier;
    this._x = x;
    this._y = y;
    this.data = data;
    if (data) {
      this.shadowPolygon = polygonFromArray(x, y, data.getShadowBoundingPolygon());
      this.rect = new Rect(x + data.lsBox.x, y + data.lsBox.y, data.lsBox.w, data.lsBox.h);
    }
    this._state = "Static";
    this.facing = "Down";
    this.animStartTime = 0;
    this._counter = 0;
    this._frameIndex = 0;
    this._interactCount = 0;
  }
  isThere() {
    if (!this.night_only && !this.day_only) return true;
    if (this.night_only && is_night) return true;
    if (this.day_only && !is_night) return true;
    return false;
  }
  setInteract(f) {
    this._interact = f;
  }
  canInteract() {
    return !!this._interact;
  }
  interact(item) {
    this._interact(this, item);

    // this is a great big hack but i'm running out of time
    if (this.identifier === "BeetPlant" && item && item.identifier === "BucketOfWater") {
      this.setInteract((self) => {
        self.queueScript([
          "It looks healthy.",
        ]);
      });
      const farmer = findEntity("Farmer");
      if (farmer) {
        farmer.setInteract((self) => {
          if (!self.gaveShedKey) {
            self.queueScript([
              "Whoa, my plant looks way healthier!",
              "Whatever you did, you have my gratitude.",
              "Here, take this key to my shed. Help yourself to whatever's in there.#give ShedKey",
            ]);
            self.gaveShedKey = true;
          } else {
            self.queueScript([
              "Have you checked out my shed?",
            ]);
          }
        });
      }
    }
  }
  makeFuncRunCmd(cmd) {
    const tokens = cmd.split(" ");
    switch(tokens[0]) {
      case "upgrade":
        return () => {
          is_player_upgraded = true;
        };
      case "selfdestruct":
        return () => {
          if (targeted_entity === this) {
            targeted_entity = undefined;
            indicator.hide();
          }
          const i = g_level.entity_instances.indexOf(this);
          if (i >= 0) {
            g_level.entity_instances.splice(i, 1);
          }
        };
      case "warp":
        return () => {
          warp(tokens[1], parseInt(tokens[2]), parseInt(tokens[3]));
        };
      case "give":
        return () => {
          const name = tokens[1];
          const item = entity_data[name].makeInstance();
          player_inventory.push(item);
        };
      case "take":
        return () => {
          player_inventory.splice(player_inventory_index, 1);
          player_inventory_index = -1;
        }
      case "sleep":
        return () => {
          is_night = !is_night;
        }
      default:
        console.warn("unhandled command:", tokens[0]);
        return () => {};

    }
  }
  queueScript(script) {
    let is_text_showing = false;
    for (const line of script) {
      const [text, cmd] = line.split("#");
      let f;
      if (text) {
        is_text_showing = true;
        f = makeFuncShowText(text);
      } else {
        is_text_showing = false;
        f = hideText;
      }
      const g = cmd ? this.makeFuncRunCmd(cmd) : () => {};
      func_queue.push(makeFuncCompose(f, g));
    }
    if (is_text_showing) {
      func_queue.push(hideText);
    }
  }
  get x() {
    return this._x;
  }
  set x(value) {
    this._x = value;
    this.rect.x = value + this.data.lsBox.x;
    this.shadowPolygon.pos.x = value;
  }
  get y() {
    return this._y;
  }
  set y(value) {
    this._y = value;
    this.rect.y = value + this.data.lsBox.y;
    this.shadowPolygon.pos.y = value;
  }
  get state() {
    return this._state;
  }
  set state(s) {
    if (this._state !== s) {
      this._counter = 0;
      this._state = s;
    }
  }
  advance(dt) {
    this._counter += dt;
  }

  getFrame() {
    return this.data.animations[this.state][this.facing].getFrame(this._counter);
  }
}

class Frame {
  constructor(x, y, w, h, duration) {
    this.srcRect = new Rect(x, y, w, h);
    this.duration = duration ?? 1;
    console.assert(this.duration > 0);

    // optional
    this.ssSrcRect = new Rect(0, 0, 0, 0);
    this.ssOffsetX = 0;
    this.ssOffsetY = 0;
  }

  static fromJSON(json, ssJSON) {
    const frame = new Frame(
      json.frame.x, json.frame.y, json.frame.w, json.frame.h, json.duration);
    frame.ssSrcRect = new Rect(
      ssJSON.frame.x,
      ssJSON.frame.y,
      ssJSON.frame.w,
      ssJSON.frame.h);
    frame.ssOffsetX = ssJSON.spriteSourceSize.x - json.spriteSourceSize.x;
    frame.ssOffsetY = ssJSON.spriteSourceSize.y - json.spriteSourceSize.y;
    return frame;
  }
}

class AnimatedSprite {
  constructor(animation) {
    this.animation = animation;
    this.counter = 0;
    this.visible = true;
    this.x = 0;
    this.y = 0;
  }
  advance(dt) {
    this.counter += dt;
  }
  getFrame() {
    return this.animation.getFrame(this.counter);
  }
  hide() {
    this.visible = false;
  }
  show() {
    this.visible = true;
    this.counter = 0;
  }
  setPos(x, y) {
    this.x = x;
    this.y = y;
  }
}

// invariant: always has at least one frame
class Animation {
  constructor(frames) {
    console.assert(frames && frames.length > 0);
    this.loop = true;
    this.frames = frames;
    this.totalDuration = this.frames.map(f => f.duration).reduce((a, b) => a + b);
  }
  get height() {
    return this.frames[0].srcRect.h;
  }
  getFrame(t) {
    let timeInAnim = t % this.totalDuration;
    for (const frame of this.frames) {
      if (timeInAnim > frame.duration) {
        timeInAnim -= frame.duration;
      } else {
        return frame;
      }
    }
    console.assert(false); // should not be reached
  }
}

class EntityData {
  constructor(identifier) {
    this.identifier = identifier;
    // animations
    // - object. primary key: animation name, secondary key: facing
    // - should always have "Static" animation with "Down" facing
    this.animations = {};
    // base_rect
    // - relative to BOTTOM LEFT corner of the sprite AND base_rect
    // - coordinates are tiles, not pixels
    // - will flip Y when transforming to world position
    this.base_rect = new Rect(0, 0, 0, 0);
    // bounding_polygon
    // - format: [x_0, y_0, x_1, y_1, ... x_n, y_n]
    // - coordinates are tiles, not pixels
    // - vertices clockwise around the perimeter of the sprite
    // - (0, 0) is BOTTOM LEFT corner of the sprite
    // - will flip Y when transforming to world position
    this.bounding_polygon = [];
  }

  makeInstance() {
    return new Entity(this.identifier, 0, 0, this);
  }

  addAnimation(name, facing, animation) {
    if (!(name in this.animations)) this.animations[name] = {};
    this.animations[name][facing] = animation;
  }

  setStaticFrame(frame) {
    this.addAnimation("Static", "Down", new Animation([frame]));
  }

  getStaticFrame() {
    return this.animations["Static"]["Down"].frames[0];
  }

  getSpriteHeight() {
    return this.animations["Static"]["Down"].height;
  }

  getBoundingPolygon() {
    let result = [];
    for (let i = 0; i < this.bounding_polygon.length; i += 2) {
      const x = this.bounding_polygon[i];
      const y = this.bounding_polygon[i+1];
      result.push(TILE_SIZE * x);
      result.push(this.getSpriteHeight() - TILE_SIZE * y);
    }
    return result;
  }

  get lsBox() {
    if (this._lsBox) return this._lsBox;
    const x = TILE_SIZE * this.base_rect.x;
    const y = this.getSpriteHeight() - TILE_SIZE * (this.base_rect.y + this.base_rect.h);
    const w = TILE_SIZE * this.base_rect.w;
    const h = TILE_SIZE * this.base_rect.h;
    this._lsBox = new Rect(x, y, w, h);
    Object.freeze(this._lsBox);
    return this._lsBox;
  }

  getShadowBoundingPolygon() {
    const vertices = this.getBoundingPolygon();
    const base_rect = this.lsBox;
    const base_center_x = base_rect.x + 0.5 * base_rect.w;
    const base_center_y = base_rect.y + 0.5 * base_rect.h;
    const shadow_vertices = Array(vertices.length);
    for (let i = 0; i < vertices.length; i += 2) {
      const x = vertices[i];
      const y = vertices[i+1];
      const [scaled_x, scaled_y] =
        scalePoint(x, y, base_center_x, base_center_y, -1);
      shadow_vertices[i] = scaled_x;
      shadow_vertices[i+1] = scaled_y;
    }
    return shadow_vertices;
  }
}

window.addEventListener("load", main);

document.onkeydown = function (e) {
  switch (e.keyCode) {
    case 81: // q
    // cycle through -1..N-1 where N is inventory size
    player_inventory_index =
      (player_inventory_index + 2) %
      (player_inventory.length + 1) - 1;
    break;
    case 27: // esc
    if (player_inventory_index >= 0) {
      player_inventory_index = -1;
      break;
    }
    is_paused = !is_paused;
    break;
    case 38: // up arrow
    case 87: // w
    is_pressed_up = true;
    break;
    case 37: // left arrow
    case 65: // a
    is_pressed_left = true;
    break;
    case 40: // down arrow
    case 83: // s
    is_pressed_down = true;
    break;
    case 39: // right arrow
    case 68: // d
    is_pressed_right = true;
    break;
    case 69: // e
    case 90: // z
    if (e.repeat) break;
    if (is_pressed_interact) break;
    if (is_paused) break;
    is_pressed_interact = true;
    try_interact = true;
    break;
    case 32: // spacebar
    if (e.repeat) break;
    if (is_pressed_dash) break;
    if (is_paused) break;
    if (!player_can_dash) break;
    is_pressed_dash = true;
    player_can_dash = false;
    player_is_dashing = true;
    player_dash_counter = PLAYER_DASH_MAX_DURATION;
    break;
    case 80: // p
    is_debug_vis = !is_debug_vis;
    break;
  }
};

document.onkeyup = function (e) {
  switch (e.keyCode) {
    case 38: // up arrow
    case 87: // w
    is_pressed_up = false;
    break;
    case 37: // left arrow
    case 65: // a
    is_pressed_left = false;
    break;
    case 40: // down arrow
    case 83: // s
    is_pressed_down = false;
    break;
    case 39: // right arrow
    case 68: // d
    is_pressed_right = false;
    break;
    case 69: // e
    case 90: // z
    is_pressed_interact = false;
    break;
    case 32: // spacebar
    is_pressed_dash = false;
    player_is_dashing = false;
    player_dash_counter = 0;
    break;
  }
};

async function main() {
  let promises = [];

  img_spritesheet = new Image();
  img_spritesheet.src = "assets/spritesheet2.png";
  promises.push(new Promise(resolve => {
    img_spritesheet.onload = function() {
      resolve();
    };
  }));

  promises.push(
    fetch("assets/map2.ldtk")
    .then(response => response.json())
  );

  promises.push(
    fetch("assets/spritesheet2.json")
    .then(response => response.json())
  );

  charset = new Image();
  charset.src = "assets/charset.png";
  promises.push(new Promise(resolve => {
    charset.onload = function() {
      resolve();
    };
  }));

  let assets = await Promise.all(promises);

  ldtk_map = assets[1];
  spritesheet_json = assets[2];

  // --- INIT WEBGL ---
  let canvas = document.getElementById("canvas");
  gl = canvas.getContext("webgl2");
  if (!gl) {
    console.error("couldn't obtain webgl2 context");
    return;
  }

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  {
    let texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      img_spritesheet);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  }
  {
    let texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      charset);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  }

  let tex_shadow_map = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, tex_shadow_map);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.drawingBufferWidth,
      gl.drawingBufferHeight,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null);

  // --- SET UP FRAMEBUFFER (for render to texture) ---

  fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D,
    tex_shadow_map, 0);

  gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

  {
    let status = gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER);
    if (status != gl.FRAMEBUFFER_COMPLETE) {
        console.error(status.toString(16));
        return;
    }
  }

  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);

  // --- COMPILE SHADERS ---

  let vs_tiles = document.getElementById("vs_tiles").innerHTML.trim();
  let fs_tiles = document.getElementById("fs_tiles").innerHTML.trim();
  shader_programs.tiles = createProgram(gl, vs_tiles, fs_tiles);

  let vs_tiles_tint = document.getElementById("vs_tiles_tint").innerHTML.trim();
  let fs_tiles_tint = document.getElementById("fs_tiles_tint").innerHTML.trim();
  shader_programs.tiles_tint = createProgram(gl, vs_tiles_tint, fs_tiles_tint);

  let vs_tiles_mask = document.getElementById("vs_tiles_mask").innerHTML.trim();
  let fs_tiles_mask = document.getElementById("fs_tiles_mask").innerHTML.trim();
  shader_programs.tiles_mask = createProgram(gl, vs_tiles_mask, fs_tiles_mask);

  let vs_shadow = document.getElementById("vs_shadow").innerHTML.trim();
  let fs_shadow = document.getElementById("fs_shadow").innerHTML.trim();
  shader_programs.shadow = createProgram(gl, vs_shadow, fs_shadow);

  let vs_pass = document.getElementById("vs_pass").innerHTML.trim();
  let fs_pass = document.getElementById("fs_pass").innerHTML.trim();
  shader_programs.pass = createProgram(gl, vs_pass, fs_pass);

  let vs_debug = document.getElementById("vs_debug").innerHTML.trim();
  let fs_debug = document.getElementById("fs_debug").innerHTML.trim();
  shader_programs.debug = createProgram(gl, vs_debug, fs_debug);

  // --- ADD TEXT BOXES ---
  pause_text_box = new TextBox("- paused -", SCREEN_WIDTH / 2, SCREEN_HEIGHT / 2,
    undefined, HorizontalAlignment.CENTER, VerticalAlignment.CENTER);
  pause_text_box.visible = false;
  text_boxes.push(pause_text_box);
  interact_text_box = new TextBox("(placeholder)", 0, SCREEN_HEIGHT,
    undefined, HorizontalAlignment.LEFT, VerticalAlignment.BOTTOM);
  interact_text_box.visible = false;
  text_boxes.push(interact_text_box);

  // --- LOAD SPRITE DATA ---

  for (const tag of spritesheet_json.meta.frameTags) {
    let [id, animName] = tag.name.split("_");
    if (!animName) animName = "Static";
    if (!(id in entity_data)) {
      const data = new EntityData(id);
      entity_data[id] = data;
    }
    for (const facing of ["Down", "Right", "Up", "Left"]) {
      const frames = [];
      for (let i = tag.from; i <= tag.to; i++) {
        const key = `${i}_${facing}`;
        const ssKey = `${i}_${facing}_ss`;
        const json = spritesheet_json.frames[key];
        const ssJSON = spritesheet_json.frames[ssKey];
        const frame = Frame.fromJSON(json, ssJSON);
        frames.push(frame);
      }
      entity_data[id].addAnimation(animName, facing, new Animation(frames));
    }
  }

  indicator = new AnimatedSprite(entity_data["Indicator"].animations["Static"]["Down"]);
  indicator.hide();
  animated_sprites.push(indicator);
  const inventory_box = new AnimatedSprite(entity_data["InventoryBox"].animations["Static"]["Down"]);
  inventory_box.setPos(SCREEN_WIDTH - 3 * TILE_SIZE, SCREEN_HEIGHT - 3 * TILE_SIZE);
  animated_sprites.push(inventory_box);


  entity_data["Chair"].base_rect = new Rect(0.25, 0.25, .5, .5);

  entity_data["Bed"].base_rect = new Rect(0.5, 0.5, 2, 1);
  entity_data["Bed"].bounding_polygon = [
    1, 1,
    1, 2,
    3, 2,
    3, 1,
  ];

  entity_data["Table"].base_rect = new Rect(0.5, 0.5, 2, 1);
  entity_data["Table"].bounding_polygon = [
    1, 1,
    1, 2,
    3, 2,
    3, 1,
  ];

  entity_data["Clothesline"].base_rect = new Rect(0.5, 0.5, 3, 0);
  entity_data["Clothesline"].bounding_polygon = [
    .5, .5,
    2, 2,
    5, 2,
    3.5, .5,
  ];

  entity_data["TallTree"].base_rect = new Rect(0, 0, 1, 1);
  entity_data["TallTree"].bounding_polygon = [
    0, 0,
    1, 2,
    1, 3,
    3, 3,
    3, 1,
    2, 1,
  ];

  entity_data["Tree"].base_rect = new Rect(0, 0, 1, 1);
  entity_data["Tree"].bounding_polygon = [
    0, 0,
    1, 2,
    2, 2,
    2, 1,
  ];

  entity_data["BeetPlant"].base_rect = new Rect(.25, .25, .5, .5);
  entity_data["BeetPlant"].bounding_polygon = [
    0, 0,
    0, 1,
    1, 2,
    2, 2,
    2, 1,
    1, 0,
  ];

  entity_data["Merchant"].base_rect = new Rect(.25, .25, .5, .5);
  entity_data["Merchant"].bounding_polygon = [
    0, 0,
    0, 1,
    1, 2,
    2, 2,
    2, 1,
    1, 0,
  ];

  entity_data["Kid"].base_rect = new Rect(.25, .25, .5, .5);
  entity_data["Kid"].bounding_polygon = [
    0, 0,
    0, 1,
    1, 2,
    2, 2,
    2, 1,
    1, 0,
  ];

  entity_data["Woman"].base_rect = new Rect(.25, .25, .5, .5);
  entity_data["Woman"].bounding_polygon = [
    0, 0,
    0, 1,
    1, 2,
    2, 2,
    2, 1,
    1, 0,
  ];

  entity_data["Farmer"].base_rect = new Rect(.25, .25, .5, .5);
  entity_data["Farmer"].bounding_polygon = [
    0, 0,
    0, 1,
    1, 2,
    2, 2,
    2, 1,
    1, 0,
  ];

  entity_data["Gravedigger"].base_rect = new Rect(.25, .25, .5, .5);
  entity_data["Gravedigger"].bounding_polygon = [
    0, 0,
    0, 1,
    1, 2,
    2, 2,
    2, 1,
    1, 0,
  ];

  entity_data["Gravestone"].base_rect = new Rect(.4, .4, 1.2, .2);
  entity_data["Gravestone"].bounding_polygon = [
    .5, .5,
    1.5, 1.5,
    2.5, 1.5,
    1.5, .5,
  ];

  entity_data["FenceDoor"].base_rect = new Rect(.4, .4, 1.2, .2);
  entity_data["FenceDoor"].bounding_polygon = [
    .5, .5,
    1.5, 1.5,
    2.5, 1.5,
    1.5, .5,
  ];

  entity_data["VerticalFence"].base_rect = new Rect(.4, .4, .2, 6.2);
  entity_data["VerticalFence"].bounding_polygon = [
    .5, .5,
    .5, 6.5,
    1.5, 7.5,
    1.5, 1.5,
  ];

  entity_data["HorizontalFence"].base_rect = new Rect(.4, .4, 6.2, .2);
  entity_data["HorizontalFence"].bounding_polygon = [
    .5, .5,
    1.5, 1.5,
    7.5, 1.5,
    6.5, .5,
  ];

  entity_data["Tent"].base_rect = new Rect(.5, .5, 2, 2);
  entity_data["Tent"].no_collision = true;
  entity_data["Tent"].bounding_polygon = [
    1.5, 1.5,
    1.5, 3.5,
    3.5, 3.5,
    3.5, 1.5,
  ];

  entity_data["Clocktower"].base_rect = new Rect(0, 0, 2, 2);
  entity_data["Clocktower"].bounding_polygon = [
    0, 0,
    0, 2,
    2, 4,
    4, 5,
    4, 2,
    2, 0,
  ];

  entity_data["House"].base_rect = new Rect(0, 0, 4, 3);
  entity_data["House"].bounding_polygon = [
    0, 0,
    0, 3,
    2, 5,
    5, 6,
    6, 5,
    6, 2,
    4, 0,
  ];

  entity_data["HayPile"].base_rect = new Rect(0, 0, 3, 2);
  entity_data["HayPile"].bounding_polygon = [
    0, 0,
    0, 1,
    1, 2,
    3, 2,
    3, 1,
    2, 0,
  ];

  entity_data["Shed"].base_rect = new Rect(0, 0, 2, 2);
  entity_data["Shed"].bounding_polygon = [
    0, 0,
    0, 2,
    1, 3,
    3, 4,
    3, 1,
    2, 0,
  ];

  entity_data["Well"].base_rect = new Rect(0.5, 0.5, 1, 1);
  entity_data["Well"].bounding_polygon = [
    1, 1,
    1, 3,
    3, 4,
    3, 2,
  ];

  entity_data["CeilingSlats"].base_rect = new Rect(-4, -4, 1, 1);
  entity_data["CeilingSlats"].bounding_polygon = [
    0, 0,
    0, 4,
    4, 4,
    4, 0,
  ];
  entity_data["CeilingSlats2"].base_rect = new Rect(-5, -5, 1, 1);
  entity_data["CeilingSlats2"].bounding_polygon = [
    0, 0,
    0, 2,
    2, 2,
    2, 0,
  ];
  entity_data["LightGradient"].base_rect = new Rect(-5, -4, 1, 1);
  entity_data["LightGradient"].bounding_polygon = [
    0, 0,
    0, 3,
    2, 3,
    2, 0,
  ];


  for (const item_name of [
    "BucketOfWater",
    "EmptyBucket",
    "BeetRoot",
    "Pickaxe",
    "IronOre",
    "Coin",
    "ShedKey",
    "Rope",
    "Mask",
    "RedStone",
    "Spoon",
    "EmptyCan",
    "IronPowder",
    "BeetJuice",
    "LifeElixir",
    "MortarAndPestle",
  ]) {
    entity_data[item_name].base_rect = new Rect(.25, .25, .5, .5);
    entity_data[item_name].no_shadow = true;
  }

  player_inventory.push(entity_data["Rope"].makeInstance());
  player_inventory.push(entity_data["Rope"].makeInstance());

  entity_data["OpenMine"].no_shadow = true;
  entity_data["ClosedMine"].no_shadow = true;

  entity_data["DebugBlock"].base_rect = new Rect(0, 0, 1, 1);
  entity_data["DebugBlock"].bounding_polygon = [
    0, 0,
    0, 1,
    1, 2,
    2, 2,
    2, 1,
    1, 0,
  ];

  entity_data["Player"].base_rect = new Rect(0.25, 0.25, 0.5, 0.5);
  entity_data["Player"].bounding_polygon = [
    0, 0,
    0, 1,
    1, 2,
    2, 2,
    2, 1,
    1, 0,
  ];

  player_light_sensors = [
     8, 24,
    16, 16,
    24,  8, 
  ];
  player_shadow_level = 0;
  player_light_level = 0;

  // --- CONSTRUCT GEOMETRY ---

  buffer_unit_rect = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer_unit_rect);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    0, 0,
    1, 0,
    1, 1,
    0, 1,
  ]), gl.STATIC_DRAW);

  {
    buffer_debug = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer_debug);
    const verts = [
      0, 0,
      1, 0,
      1, 1,
      0, 1,
      0, 0,
      1, 1,
      1, 0,
      0, 1,
    ];
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    buffer_debug_length = verts.length / 2;
  }

  for (const entity_name of Object.keys(entity_data)) {
    const data = entity_data[entity_name];
    const vertices = data.getBoundingPolygon();

    data.num_verts = vertices.length / 2;
    data.bounding_polygon_buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, data.bounding_polygon_buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);

    const base_rect = data.lsBox;
    const base_center_x = base_rect.x + 0.5 * base_rect.w;
    const base_center_y = base_rect.y + 0.5 * base_rect.h;

    const shadow_vertices = Array(vertices.length);
    for (let i = 0; i < vertices.length; i += 2) {
      const x = vertices[i];
      const y = vertices[i+1];
      const [scaled_x, scaled_y] =
        scalePoint(x, y, base_center_x, base_center_y, -1);
      shadow_vertices[i] = scaled_x;
      shadow_vertices[i+1] = scaled_y;
    }

    data.shadow_bounding_polygon_buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, data.shadow_bounding_polygon_buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(shadow_vertices), gl.STATIC_DRAW);
  }

  // --- SPAWN ENTITIES ---

  for (const level of ldtk_map.levels) {
    const entity_instances = [];
    const triggers = [];
    const tiles = [];
    const invisible_walls = [];
    level.layerInstances.reverse();
    for (const layer of level.layerInstances) {
      for (const tile of layer.gridTiles) {
        tiles.push(tile);
      }
      for (const entity of layer.entityInstances) {
        const inst = new Entity(
          entity.__identifier,
          entity.__worldX,
          entity.__worldY,
          entity_data[entity.__identifier]);
        if (entity.__identifier !== "Trigger" && entity.__identifier !== "InvisibleWall") {
          entity_instances.push(inst);
        }
        if (entity.__identifier === "Player") {
          console.assert(!player);
          player = inst;
          g_level_name = level.identifier;
        }
        if (entity.__identifier === "InvisibleWall") {
          invisible_walls.push(new Rect(entity.__worldX, entity.__worldY, entity.width, entity.height));
        }
        if (entity.__identifier === "Trigger") {
          triggers.push(inst);
          inst.trigger_is_active = true;
          inst.trigger_rect = new Rect(
            entity.px[0] + level.worldX, entity.px[1] + level.worldY,
            entity.width, entity.height);
          const fields = makeObjectFromFieldInstances(entity.fieldInstances);
          inst.setInteract((self, item) => {
            if (self.trigger_is_active) {
              self.queueScript(fields.script);
              // since the player didn't press interact,
              // we explicitly pop off the queue and execute
              const func = func_queue.shift();
              if (func) func();
            }
            if (fields.oneTimeUse) {
              self.trigger_is_active = false;
            }
          });
        } else { // not trigger
          const fields = makeObjectFromFieldInstances(entity.fieldInstances);
          if (fields && fields.night_only) {
            inst.night_only = true;
          }
          if (fields && fields.day_only) {
            inst.day_only = true;
          }
          if (fields && fields.script && fields.script.length > 0) {
            inst.setInteract((self, item) => {
              if (item && item.identifier === fields.trigger_item) {
                self.queueScript(fields.script_item);
              } else {
                if (self._interactCount % 2 === 0) {
                  self.queueScript(fields.script);
                } else {
                  if (fields.script2 && fields.script2.length > 0) {
                    self.queueScript(fields.script2);
                  } else {
                    self.queueScript(fields.script);
                  }
                }
                self._interactCount++;
              }
            });
          }
        }
        if (entity.__identifier === "RedStone") {
          standardizeItem(inst);
        }
      }
    }
    const new_level = new Level(level.worldX, level.worldY, level.pxWid, level.pxHei, entity_instances, triggers, tiles, invisible_walls);
    const fields = makeObjectFromFieldInstances(level.fieldInstances);
    Object.assign(new_level, fields);
    g_levels[level.identifier] = new_level;
  }

  g_level = g_levels[g_level_name];

  checkpoint_x = player.x;
  checkpoint_y = player.y;
  checkpoint_level_name = g_level_name;

  // --- SET UP VERTEX ARRAYS ---

  gl.enableVertexAttribArray(0);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer_unit_rect);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  gl.enableVertexAttribArray(1);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer_debug);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);

  window.requestAnimationFrame(step);
}

// --- HELPERS ---

function createProgram(gl, vs_source, fs_source) {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, vs_source);
  gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(vs));
    return;
  }

  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, fs_source);
  gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(fs));
    return;
  }

  let program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.detachShader(program, vs);
  gl.detachShader(program, fs);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error(gl.getProgramInfoLog(program));
    return;
  }

  return program;
}

function step(timestamp) {
  const dt = timestamp - prev_timestamp;
  prev_timestamp = timestamp;
  time_since_last_draw += dt;
  if (time_since_last_draw >= TARGET_FRAME_DURATION) {
    time_since_last_draw %= TARGET_FRAME_DURATION;
    update(dt);
    render();
  }
  window.requestAnimationFrame(step);
}

function update(dt) {
  // if paused, return early
  pause_text_box.visible = is_paused;
  if (is_paused) {
    return;
  }

  if (try_interact) {
    try_interact = false;
    if (func_queue.length === 0) {
      if (targeted_entity) {
        const item = player_inventory_index >= 0 ? player_inventory[player_inventory_index] : null;
        targeted_entity.interact(item);
      } else if (player_inventory_index >= 0) {
        dropItem();
      }
    }
    // queue may have been updated
    if (func_queue.length > 0) {
      func_queue.shift()();
      return;
    }
  }

  // if queue still has stuff, skip rest of update()
  if (func_queue.length > 0) {
    return;
  }

  // advance animated sprite timers
  for (const sprite of animated_sprites) {
    sprite.advance(dt);
  }

  // advance entity timers
  for (const entity of g_level.entity_instances) {
    entity.advance(dt);
  }

  // update targeted entity
  {
    const [x1, y1] = player.rect.centroid();
    if (targeted_entity) {
      const [x2, y2] = targeted_entity.rect.centroid();
      const dist = Math.sqrt(Math.pow(x1 - x2, 2) + Math.pow(y1 - y2, 2));
      // TODO factor out magic number
      if (dist > 32) {
        targeted_entity = undefined;
        indicator.hide();
      }
    }
    if (!targeted_entity) {
      for (const entity of g_level.entity_instances) {
        if (player === entity) continue;
        if (!entity.isThere()) continue;
        if (!entity.canInteract()) continue;
        if (!entity.rect) continue;
        const [x2, y2] = entity.rect.centroid();
        const dist = Math.sqrt(Math.pow(x1 - x2, 2) + Math.pow(y1 - y2, 2));
        if (dist < 32) {
          targeted_entity = entity;
          indicator.show();
          break;
        }
      }
    }
  }

  // update indicator position
  if (targeted_entity) {
    const [cx, cy] = getCameraPosition();
    indicator.setPos(
      targeted_entity.x + targeted_entity.rect.w - cx,
      targeted_entity.y - cy - TILE_SIZE);
  }

  player_dash_counter = Math.max(0, player_dash_counter - dt);
  if (player_dash_counter === 0) {
    player_is_dashing = false;
  }
  player_velocity_target = lerp(
    PLAYER_LOW_SPEED,
    PLAYER_HIGH_SPEED,
    2 * player_shadow_level / player_light_sensors.length);

  if (player_is_dashing) {
    player_velocity = PLAYER_DASH_SPEED;
    player_velocity_target = PLAYER_DASH_SPEED;
  } else {
    if (player_velocity < player_velocity_target) {
      const diff =  player_velocity_target - player_velocity;
      player_velocity += Math.min(diff, PLAYER_VELOCITY_MAX_INCREMENT);
    } else {
      let decrement = PLAYER_VELOCITY_MAX_DECREMENT;
      const diff = player_velocity - player_velocity_target;
      player_velocity -= Math.min(diff, decrement);
    }
  }

  let dx = 0;
  let dy = 0;
  if (is_pressed_right) {
    dx += player_velocity;
  }
  if (is_pressed_left) {
    dx -= player_velocity;
  }
  if (is_pressed_up) {
    dy -= player_velocity;
  }
  if (is_pressed_down) {
    dy += player_velocity;
  }

  if (player_is_dashing) {
    player.state = "Dash";
  } else {
    if (dx !== 0 || dy !== 0) {
      player.state = "Walk";
    } else {
      player.state = "Idle";
    }
  }

  if (dx > 0) {
    player.facing = "Right";
  } else if (dx < 0) {
    player.facing = "Left";
  }

  if (dy > 0) {
    player.facing = "Down";
  } else if (dy < 0) {
    player.facing = "Up";
  }

  if (dx !== 0 && dy !== 0) {
    dx *= ONE_OVER_SQRT_OF_TWO;
    dy *= ONE_OVER_SQRT_OF_TWO;
  }

  // collision detection
  {
    const rectCopy = player.rect.copy();
    const oldPlayerX = player.x;
    const oldPlayerY = player.y;

    player.x += dx;
    for (const entity of g_level.entity_instances) {
      if (!entity.isThere()) continue;
      if (entity.data.no_collision) continue;
      if (entity.identifier === "Player") continue;
      if (player.rect.test(entity.rect)) {
        player.x = oldPlayerX + rectCopy.xDistTo(entity.rect, 1e-12);
      }
    }
    for (const wall of g_level.invisible_walls) {
      if (player.rect.test(wall)) {
        player.x = oldPlayerX + rectCopy.xDistTo(wall, 1e-12);
      }
    }

    player.y += dy;
    for (const entity of g_level.entity_instances) {
      if (!entity.isThere()) continue;
      if (entity.data.no_collision) continue;
      if (entity.identifier === "Player") continue;
      if (player.rect.test(entity.rect)) {
        player.y = oldPlayerY + rectCopy.yDistTo(entity.rect, 1e-12);
      }
    }
    for (const wall of g_level.invisible_walls) {
      if (player.rect.test(wall)) {
        player.y = oldPlayerY + rectCopy.yDistTo(wall, 1e-12);
      }
    }
  }

  // limit player to play area
  {
    const box = player.data.lsBox;
    player.x = Math.max(g_level.x, player.x + box.x) - box.x;
    player.y = Math.max(g_level.y, player.y + box.y) - box.y;
    player.x = Math.min(g_level.x + g_level.w - box.w, player.x + box.x) - box.x;
    player.y = Math.min(g_level.y + g_level.h - box.h, player.y + box.y) - box.y;
  }


  // trigger detection
  for (const trigger of g_level.triggers) {
    if (!trigger.trigger_is_active) continue;
    if (player.rect.test(trigger.trigger_rect)) {
      trigger.interact();
    }
  }

  // calculate shadow level
  {
    let shadow_level = 0;
    forEachPair(player_light_sensors, (x, y) => {
      const point = new SAT.Vector(player.x + x, player.y + y);
      for (const entity of g_level.entity_instances) {
        if (!entity.isThere()) continue;
        if (entity.identifier === "Player") continue;
        const polygon = entity.shadowPolygon;
        if (!polygon) continue;
        if (SAT.pointInPolygon(point, polygon)) {
          shadow_level++;
          return;
        }
      }
    });
    player_shadow_level = shadow_level;
  }
  if (is_night || g_level.is_indoors || is_player_upgraded) {
    player_shadow_level = player_light_sensors.length / 2.0;
  }

  // if shadow level is at max, set checkpoint
  if (player_shadow_level === player_light_sensors.length / 2) {
    checkpoint_x = player.x;
    checkpoint_y = player.y;
    checkpoint_level_name = g_level_name;
  }
  if (player_shadow_level === 0 && !player_is_dashing) {
    player_light_level += dt;
  }
  if (player_shadow_level > 0) {
    player_light_level = 0;
  }
  if (player_light_level >= PLAYER_MAX_LIGHT_LEVEL) {
    makeFuncShowText("You have turned to stone.")();
    func_queue.push(makeFuncCompose(hideText, () => {
      warp(checkpoint_level_name, checkpoint_x, checkpoint_y);
      player_light_level = 0;
    }));
  }

  if (!player_can_dash && player_shadow_level > 0 && !player_is_dashing) {
    player_can_dash = true;
  }
}

function render() {
  // --- build shadow map ---
  {
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb);

    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(shader_programs.shadow);

    let u_tex = gl.getUniformLocation(shader_programs.shadow, "tex");
    let u_texSize = gl.getUniformLocation(shader_programs.shadow, "texSize");
    let u_screenSize = gl.getUniformLocation(shader_programs.shadow, "screenSize");
    let u_srcRect = gl.getUniformLocation(shader_programs.shadow, "srcRect");
    let u_dstRect = gl.getUniformLocation(shader_programs.shadow, "dstRect");
    let u_origin = gl.getUniformLocation(shader_programs.shadow, "origin");
    let u_cameraPos = gl.getUniformLocation(shader_programs.shadow, "cameraPos");

    gl.uniform1i(u_tex, 0);
    gl.uniform2f(u_texSize, img_spritesheet.width, img_spritesheet.height);
    gl.uniform2f(u_screenSize, SCREEN_WIDTH, SCREEN_HEIGHT);
    const [cx, cy] = getCameraPosition();
    gl.uniform2f(u_cameraPos, (cx), (cy));

    for (const entity of g_level.entity_instances) {
      if (!entity.isThere()) continue;
      if (entity.data.no_shadow) continue;
      const base = Object.assign({}, entity.data.lsBox);
      base.x += entity.x;
      base.y += entity.y;
      const base_center_x = (2 * base.x + base.w) / 2.0;
      const base_center_y = (2 * base.y + base.h) / 2.0;
      const rect = entity.getFrame().srcRect;
      gl.uniform4f(u_srcRect, rect.x, rect.y, rect.w, rect.h);
      gl.uniform4f(u_dstRect, Math.round(entity.x), Math.round(entity.y), rect.w, rect.h);
      gl.uniform2f(u_origin, Math.round(base_center_x), Math.round(base_center_y));
      gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
    }

    // --- subtract entities and add self-shadow ---
    {
      gl.useProgram(shader_programs.tiles_mask);

      let u_tex = gl.getUniformLocation(shader_programs.tiles_mask, "tex");
      let u_texSize = gl.getUniformLocation(shader_programs.tiles_mask, "texSize");
      let u_screenSize = gl.getUniformLocation(shader_programs.tiles_mask, "screenSize");
      let u_srcRect = gl.getUniformLocation(shader_programs.tiles_mask, "srcRect");
      let u_dstRect = gl.getUniformLocation(shader_programs.tiles_mask, "dstRect");
      let u_cameraPos = gl.getUniformLocation(shader_programs.tiles_mask, "cameraPos");

      gl.blendEquation(gl.FUNC_REVERSE_SUBTRACT);
      gl.blendFunc(gl.ONE, gl.ONE);

      gl.uniform1i(u_tex, 0);
      gl.uniform2f(u_texSize, img_spritesheet.width, img_spritesheet.height);
      gl.uniform2f(u_screenSize, SCREEN_WIDTH, SCREEN_HEIGHT);
      const [cx, cy] = getCameraPosition();
      gl.uniform2f(u_cameraPos, (cx), (cy));

      // subtract entities
      for (const entity of g_level.entity_instances) {
        if (!entity.isThere()) continue;
        if (entity.identifier === "Player") continue;
        const rect = entity.data.getStaticFrame().srcRect;
        gl.uniform4f(u_srcRect, rect.x, rect.y, rect.w, rect.h);
        gl.uniform4f(u_dstRect, Math.round(entity.x), Math.round(entity.y), rect.w, rect.h);
        gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
      }

      // return to default blend function
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      // add entity self-shadow
      for (const entity of g_level.entity_instances) {
        if (!entity.isThere()) continue;
        const frame = entity.data.getStaticFrame();
        const rect = frame.ssSrcRect;
        gl.uniform4f(u_srcRect, rect.x, rect.y, rect.w, rect.h);
        gl.uniform4f(u_dstRect, Math.round(entity.x + frame.ssOffsetX), Math.round(entity.y + frame.ssOffsetY), rect.w, rect.h);
        gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
      }

    }

    if (is_night || g_level.is_indoors) {
      gl.clearColor(1.0, 1.0, 1.0, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  // --- main pass ---
  {
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);

    gl.clearColor(0.7, 0.7, 0.7, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // --- render tiles ---
    {
      gl.useProgram(shader_programs.tiles);

      let u_tex = gl.getUniformLocation(shader_programs.tiles, "tex");
      let u_texSize = gl.getUniformLocation(shader_programs.tiles, "texSize");
      let u_screenSize = gl.getUniformLocation(shader_programs.tiles, "screenSize");
      let u_srcRect = gl.getUniformLocation(shader_programs.tiles, "srcRect");
      let u_dstRect = gl.getUniformLocation(shader_programs.tiles, "dstRect");
      let u_cameraPos = gl.getUniformLocation(shader_programs.tiles, "cameraPos");

      gl.uniform1i(u_tex, 0);
      gl.uniform2f(u_texSize, img_spritesheet.width, img_spritesheet.height);
      gl.uniform2f(u_screenSize, SCREEN_WIDTH, SCREEN_HEIGHT);
      const [cx, cy] = getCameraPosition();
      gl.uniform2f(u_cameraPos, (cx), (cy));

      for (const tile of g_level.tiles) {
        gl.uniform4f(u_srcRect,
          tile.src[0], tile.src[1], TILE_SIZE, TILE_SIZE);
        gl.uniform4f(u_dstRect,
          g_level.x + tile.px[0], g_level.y + tile.px[1], TILE_SIZE, TILE_SIZE);
        gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
      }
    }

    // --- render entities ---
    {
      gl.useProgram(shader_programs.tiles);

      let u_tex = gl.getUniformLocation(shader_programs.tiles, "tex");
      let u_texSize = gl.getUniformLocation(shader_programs.tiles, "texSize");
      let u_screenSize = gl.getUniformLocation(shader_programs.tiles, "screenSize");
      let u_srcRect = gl.getUniformLocation(shader_programs.tiles, "srcRect");
      let u_dstRect = gl.getUniformLocation(shader_programs.tiles, "dstRect");
      let u_cameraPos = gl.getUniformLocation(shader_programs.tiles, "cameraPos");

      gl.uniform1i(u_tex, 0);
      gl.uniform2f(u_texSize, img_spritesheet.width, img_spritesheet.height);
      gl.uniform2f(u_screenSize, SCREEN_WIDTH, SCREEN_HEIGHT);
      const [cx, cy] = getCameraPosition();
      gl.uniform2f(u_cameraPos, (cx), (cy));

      for (const entity of g_level.entity_instances) {
        if (!entity.isThere()) continue;
        const rect = entity.getFrame().srcRect;
        gl.uniform4f(u_srcRect, rect.x, rect.y, rect.w, rect.h);
        gl.uniform4f(u_dstRect, Math.round(entity.x), Math.round(entity.y), rect.w, rect.h);
        gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
      }
    }
    // --- render player tint ---
    {
      gl.useProgram(shader_programs.tiles_tint);

      let u_tex = gl.getUniformLocation(shader_programs.tiles_tint, "tex");
      let u_texSize = gl.getUniformLocation(shader_programs.tiles_tint, "texSize");
      let u_screenSize = gl.getUniformLocation(shader_programs.tiles_tint, "screenSize");
      let u_srcRect = gl.getUniformLocation(shader_programs.tiles_tint, "srcRect");
      let u_dstRect = gl.getUniformLocation(shader_programs.tiles_tint, "dstRect");
      let u_cameraPos = gl.getUniformLocation(shader_programs.tiles_tint, "cameraPos");
      let u_tintAmount = gl.getUniformLocation(shader_programs.tiles_tint, "tintAmount");
      let u_tintColor = gl.getUniformLocation(shader_programs.tiles_tint, "tintColor");

      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE);

      gl.uniform1i(u_tex, 0);
      gl.uniform2f(u_texSize, img_spritesheet.width, img_spritesheet.height);
      gl.uniform2f(u_screenSize, SCREEN_WIDTH, SCREEN_HEIGHT);
      gl.uniform3f(u_tintColor, 0, 1, 1);
      gl.uniform1f(u_tintAmount, player_light_level / PLAYER_MAX_LIGHT_LEVEL);
      const [cx, cy] = getCameraPosition();
      gl.uniform2f(u_cameraPos, (cx), (cy));

      const rect = player.getFrame().srcRect;
      gl.uniform4f(u_srcRect, rect.x, rect.y, rect.w, rect.h);
      gl.uniform4f(u_dstRect, Math.round(player.x), Math.round(player.y), rect.w, rect.h);
      gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);

      // return to default blend function
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }

    // --- render shadow map texture to screen ---
    {
      /**
       * custom blend function for color inversion:
       *
       *   finalColor = (1 - dstColor) * srcColor + (1 - srcAlpha) * dstColor
       *
       * for shadow map texel (1, 1, 1, 1), finalColor => (1 - dstColor)
       * for shadow map texel (0, 0, 0, 0), finalColor => dstColor
       */
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFuncSeparate(
        gl.ONE_MINUS_DST_COLOR, gl.ONE_MINUS_SRC_ALPHA,
        gl.ZERO, gl.ONE);
      gl.useProgram(shader_programs.pass);
      let u_tex = gl.getUniformLocation(shader_programs.pass, "tex");
      gl.uniform1i(u_tex, 1);
      gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);

      // return to default blend function
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }

    // --- render text and ui ---
    {
      gl.useProgram(shader_programs.tiles);

      let u_tex = gl.getUniformLocation(shader_programs.tiles, "tex");
      let u_texSize = gl.getUniformLocation(shader_programs.tiles, "texSize");
      let u_screenSize = gl.getUniformLocation(shader_programs.tiles, "screenSize");
      let u_srcRect = gl.getUniformLocation(shader_programs.tiles, "srcRect");
      let u_dstRect = gl.getUniformLocation(shader_programs.tiles, "dstRect");
      let u_cameraPos = gl.getUniformLocation(shader_programs.tiles, "cameraPos");

      gl.uniform2f(u_screenSize, SCREEN_WIDTH, SCREEN_HEIGHT);
      gl.uniform2f(u_cameraPos, 0, 0);

      gl.uniform1i(u_tex, 0);
      gl.uniform2f(u_texSize, img_spritesheet.width, img_spritesheet.height);

      // render indicator
      for (const sprite of animated_sprites) {
        if (!sprite.visible) continue;
        const s = sprite.getFrame().srcRect;
        gl.uniform4f(u_srcRect,
          Math.round(s.x), Math.round(s.y),
          Math.round(s.w), Math.round(s.h));
        gl.uniform4f(u_dstRect,
          Math.round(sprite.x), Math.round(sprite.y),
          Math.round(s.w), Math.round(s.h));
        gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
      }

      // render inventory
      if (player_inventory_index >= 0) {
        const item = player_inventory[player_inventory_index];
        const s = item.getFrame().srcRect;
        gl.uniform4f(u_srcRect, s.x, s.y, s.w, s.h);
        gl.uniform4f(u_dstRect,
          SCREEN_WIDTH - 2 * TILE_SIZE, SCREEN_HEIGHT - 2 * TILE_SIZE,
          s.w, s.h);
        gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
      }

      // draw text
      gl.uniform1i(u_tex, 2);
      gl.uniform2f(u_texSize, charset.width, charset.height);
      for (const textBox of text_boxes) {
        if (!textBox.visible) continue;
        {
          const r = textBox.bgRect();
          gl.uniform4f(u_srcRect,
            0, 0,
            CHARSET_TILE_WIDTH, CHARSET_TILE_HEIGHT);
          gl.uniform4f(u_dstRect,
            Math.round(r.x), Math.round(r.y),
            Math.round(r.w), Math.round(r.h));
          gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
        }
        for (const [s, d] of textBox.charRects()) {
          gl.uniform4f(u_srcRect,
            Math.round(s.x), Math.round(s.y),
            Math.round(s.w), Math.round(s.h));
          gl.uniform4f(u_dstRect,
            Math.round(d.x), Math.round(d.y),
            Math.round(d.w), Math.round(d.h));
          gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
        }
      }


    }

    // --- render debug collision ---
    if (is_debug_vis) {
      gl.useProgram(shader_programs.debug);

      let u_screenSize = gl.getUniformLocation(shader_programs.debug, "screenSize");
      let u_cameraPos = gl.getUniformLocation(shader_programs.debug, "cameraPos");
      let u_worldPos = gl.getUniformLocation(shader_programs.debug, "worldPos");
      let u_debugColor = gl.getUniformLocation(shader_programs.debug, "debugColor");
      let u_scale = gl.getUniformLocation(shader_programs.debug, "scale");

      gl.uniform2f(u_screenSize, SCREEN_WIDTH, SCREEN_HEIGHT);
      const [cx, cy] = getCameraPosition();
      gl.uniform2f(u_cameraPos, (cx), (cy));
      gl.uniform2f(u_scale, 1, 1);

      for (const entity of g_level.entity_instances) {
        if (!entity.isThere()) continue;
        // --- draw bounding polygon ---
        gl.uniform3f(u_debugColor, 1, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, entity.data.bounding_polygon_buffer);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
        gl.uniform2f(u_worldPos, entity.x, entity.y);
        gl.drawArrays(gl.LINE_LOOP, 0, entity.data.num_verts);

        // --- draw shadow bounding polygon ---
        gl.uniform3f(u_debugColor, 0, 1, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, entity.data.shadow_bounding_polygon_buffer);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
        gl.uniform2f(u_worldPos,
          entity.shadowPolygon.pos.x,
          entity.shadowPolygon.pos.y);
        gl.drawArrays(gl.LINE_LOOP, 0, entity.data.num_verts);
      }

      // --- draw entity bases ---
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer_debug);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
      gl.uniform3f(u_debugColor, 0, 1, 1);

      for (const entity of g_level.entity_instances) {
        if (!entity.isThere()) continue;
        gl.uniform2f(u_scale, entity.rect.w, entity.rect.h);
        gl.uniform2f(u_worldPos, entity.rect.x, entity.rect.y);
        gl.drawArrays(gl.LINE_STRIP, 0, buffer_debug_length);
      }

      // draw triggers
      for (const trigger of g_level.triggers) {
        if (trigger.trigger_is_active) {
          gl.uniform3f(u_debugColor, 0, 1, 0);
        } else {
          gl.uniform3f(u_debugColor, 1, 0, 1);
        }
        gl.uniform2f(u_scale, trigger.trigger_rect.w, trigger.trigger_rect.h);
        gl.uniform2f(u_worldPos, trigger.trigger_rect.x, trigger.trigger_rect.y);
        gl.drawArrays(gl.LINE_STRIP, 0, buffer_debug_length);
      }
    }

    // update debug read-out
    {
      const shadow_level_span = document.getElementById("shadowLevel");
      const total = player_light_sensors.length / 2.0;
      const meter = [];
      for (let i = 0; i < total; i++) {
        if (i < player_shadow_level) meter.push("#");
        else meter.push("-");
      }
      const result = meter.join("");
      if (shadow_level_span.innerHTML !== result) {
        shadow_level_span.innerHTML = result;
      }
    }
    {
      const span = document.getElementById("lightLevel");
      const meter = [];
      for (let i = 0; i < PLAYER_MAX_LIGHT_LEVEL; i += 200) {
        if (i < player_light_level) meter.push("#");
        else meter.push("-");
      }
      const result = meter.join("");
      if (span.innerHTML !== result) {
        span.innerHTML = result;
      }
    }
    {
      const span = document.getElementById("playerSpeed");
      span.innerHTML = player_velocity.toPrecision(2);
    }
    {
      const span = document.getElementById("playerState");
      span.innerHTML = player.state;
    }
    {
      const span = document.getElementById("canDash");
      span.innerHTML = player_can_dash;
    }
    {
      const span = document.getElementById("playerInventoryIndex");
      span.innerHTML = player_inventory_index;
    }
    {
      const span = document.getElementById("playerInventory");
      const result = player_inventory.map((item, index) => { return (index === player_inventory_index ? ">" : "") + item.identifier; }).join();
      span.innerHTML = result;
    }
    {
      const span = document.getElementById("dashCounter");
      const meter = [];
      for (let i = 0; i < PLAYER_DASH_MAX_DURATION; i += 50) {
        if (i < player_dash_counter) meter.push("#");
        else meter.push("-");
      }
      const result = meter.join("");
      if (span.innerHTML !== result) {
        span.innerHTML = result;
      }
    }
    {
      const span = document.getElementById("target");
      span.innerHTML = targeted_entity ? targeted_entity.identifier : "N/A";
    }
  }
}

function getCameraPosition() {
  let cx = Math.round(player.x) + 3 * TILE_SIZE - 0.5 * SCREEN_WIDTH;
  let cy = Math.round(player.y) - 0.5 * SCREEN_HEIGHT;

  cx = Math.max(g_level.x, cx);
  cy = Math.max(g_level.y, cy);

  cx = Math.min(g_level.x + g_level.w - SCREEN_WIDTH, cx);
  cy = Math.min(g_level.y + g_level.h - SCREEN_HEIGHT, cy);

  return [ cx, cy ];
}

function scalePoint(x, y, origin_x, origin_y, scale) {
  return [
    (x - origin_x) * scale + origin_x,
    (y - origin_y) * scale + origin_y,
  ];
}

function forEachPair(arr, f) {
  for (let i = 0; i < arr.length - 1; i += 2) {
    const x = arr[i];
    const y = arr[i+1];
    f(x, y);
  }
}

function polygonFromArray(x, y, arr) {
  const points = [];
  forEachPair(arr, (x, y) => {
    points.push(new SAT.Vector(x, y));
  });
  return new SAT.Polygon(new SAT.Vector(x, y), points);
}

function lerp(a, b, pct) {
  return a * (1 - pct) + b * pct;
}

function makeObjectFromFieldInstances(fieldInstances) {
  if (!fieldInstances) return undefined;
  const object = {};
  for (const field of fieldInstances) {
    object[field.__identifier] = field.__value;
  }
  return object;
}

function warp(level_name, x, y) {
  // remove player from current level
  const i = g_level.entity_instances.indexOf(player);
  if (i >= 0) g_level.entity_instances.splice(i, 1);
  // set current level
  g_level_name = level_name;
  g_level = g_levels[g_level_name];
  // add player to current level
  g_level.entity_instances.push(player);
  // set player coordinates
  player.x = x;
  player.y = y;
}

function findEntity(identifier) {
  for (const entity of g_level.entity_instances) {
    if (entity.identifier === identifier) {
      return entity;
    }
  }
  return undefined;
}

function dropItem() {
  const item = player_inventory[player_inventory_index];
  player_inventory.splice(player_inventory_index, 1);
  player_inventory_index = -1;
  item.x = player.x;
  item.y = player.y;
  g_level.entity_instances.push(item);
  standardizeItem(item);
  func_queue.push(makeFuncShowText(`Dropped ${item.identifier}`));
  func_queue.push(hideText);
}

function standardizeItem(item) {
  const standard_procedure = (self) => {
    self.queueScript([
      `Picked up ${self.identifier}#give ${self.identifier}`,
      "#selfdestruct",
    ]);
  };
  switch (item.identifier) {
    case "LifeElixir":
    item.setInteract((self) => {
      self.queueScript([
        "You drink the LifeElixir.#selfdestruct",
        "It tastes pretty gross.",
        "You feel like you're probably not a vampire anymore.",
        "Congratulations!",
      ]);
    });
    break;
    case "BeetJuice":
    item.setInteract((self, other) => {
      if (!other) {
        standard_procedure(self);
      } else if (other.identifier === "IronPowder") {
        self.queueScript([
          "You add the IronPowder to the BeetJuice.#take",
          "It becomes LifeElixir!#give LifeElixir",
          "#selfdestruct",
        ]);
      } else {
        standard_procedure(self);
      }
    });
    break;
    case "Mask":
    item.setInteract((self, other) => {
      if (!other) {
        standard_procedure(self);
      } else if (other.identifier === "RedStone") {
        self.queueScript([
          "You insert the RedStone into the socket on the Mask's forehead.#take",
          "Without thinking, you put on the mask.#selfdestruct",
          "You no longer fear the sun.#upgrade",
        ]);
      } else {
        standard_procedure(self);
      }
    });
    break;
    case "RedStone":
    item.setInteract((self, other) => {
      if (!other) {
        standard_procedure(self);
      } else if (other.identifier === "Spoon" || other.identifier === "EmptyCan") {
        self.queueScript([
          `You touch the RedStone with a ${other.identifier}. The ${other.identifier} suddenly turns into a gold Coin.#give Coin`,
          "#take",
        ]);
      } else {
        self.queueScript([
          `You touch the RedStone with a ${other.identifier}. Nothing happens`,
        ]);
      }
    });
    break;
    default:
    item.setInteract(standard_procedure);
    break;
  }
}
