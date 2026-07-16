const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
];

const SAMPLE_WORDS = [
  "anchor", "amber", "atlas", "beacon", "birch", "blossom", "breeze", "bridge",
  "canyon", "cascade", "cedar", "citadel", "coral", "crystal", "dawn", "delta",
  "desert", "drizzle", "dune", "eclipse", "ember", "falcon", "feather", "fern",
  "fjord", "forest", "frost", "garden", "geyser", "glacier", "granite", "grove",
  "harbor", "harvest", "haze", "helix", "horizon", "icicle", "inlet", "iris",
  "island", "ivory", "jade", "jasmine", "journey", "juniper", "kernel", "kettle",
  "lagoon", "lantern", "lighthouse", "lilac", "marble", "meadow", "mesa", "mist",
  "nebula", "nectar", "nimbus", "notebook", "nova", "oasis", "ocean", "opal",
  "orbit", "pasture", "pearl", "pine", "plateau", "prism", "quartz", "quill",
  "quiver", "rainbow", "ravine", "reef", "ridge", "ripple", "river", "sapphire",
  "shale", "spire", "starlight", "summit", "thistle", "thunder", "timber", "tundra",
  "tulip", "umbra", "uplift", "valley", "voyage", "vortex", "waterfall", "willow",
  "zenith",
];

function formatIsoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

class RowDefaults {
  constructor() {
    this.nextDate = this.janFirst();
  }

  janFirst() {
    const year = new Date().getFullYear();
    return new Date(year, 0, 1);
  }

  reset() {
    this.nextDate = this.janFirst();
  }

  currentDate() {
    return formatIsoDate(this.nextDate);
  }

  advanceAfterAdd() {
    this.nextDate.setDate(this.nextDate.getDate() + 1);
  }

  randomState() {
    return pickRandom(US_STATES);
  }

  randomWord() {
    return pickRandom(SAMPLE_WORDS);
  }

  populateStateSelect(select) {
    if (select.options.length > 0) return;
    for (const abbr of US_STATES) {
      const option = document.createElement("option");
      option.value = abbr;
      option.textContent = abbr;
      select.appendChild(option);
    }
  }

  fillForm(form) {
    const dateInput = form.elements.namedItem("date");
    const stateSelect = form.elements.namedItem("state");
    const valueInput = form.elements.namedItem("value");
    dateInput.value = this.currentDate();
    stateSelect.value = this.randomState();
    valueInput.value = this.randomWord();
  }
}

window.rowDefaults = new RowDefaults();
