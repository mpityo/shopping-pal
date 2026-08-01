/**
 * The starting catalog, transcribed from the Notes list.
 *
 * Two independent groupings are kept for every item:
 *   `section` / `sub` — how the list is organised in Notes (familiar)
 *   `dept`            — where it lives in the store (useful while shopping)
 *
 * The catalog is a starting point, not a fixed menu. Anything added, renamed,
 * re-aisled or archived in the app is stored on top of this seed, so pulling
 * a newer version of the site never overwrites your edits.
 */

const SEED = [
  // ── Produce ────────────────────────────────────────────────────────────
  {
    section: 'Produce',
    sub: 'Fruit',
    dept: 'produce',
    items: [
      ['Bananas', { note: '2 bunches' }],
      'Apples',
      'Strawberries',
      'Grapes',
      'Lemon',
      'Lime',
      'Avocados',
      'Cantaloupe',
    ],
  },
  {
    section: 'Produce',
    sub: 'Vegetables',
    dept: 'produce',
    items: [
      'Tomato',
      'Grape tomatoes',
      'Green onion',
      'White onion',
      'Red onion',
      'Baby carrots',
      'Shredded carrots',
      'Celery',
      ['Cucumber', { note: 'for the salad', person: 'p1' }],
      'Spinach',
      ['Mushrooms', { note: 'sliced' }],
      'Red bell pepper',
      'Green bell pepper',
      'Parsnips',
      'Russet potatoes',
      'Red potatoes',
      'Sweet potatoes',
    ],
  },
  {
    section: 'Produce',
    sub: 'Fresh Herbs',
    dept: 'produce',
    items: ['Parsley', 'Cilantro', 'Dill'],
  },

  // ── Frozen ─────────────────────────────────────────────────────────────
  {
    section: 'Frozen',
    sub: 'Vegetables & Fruit',
    dept: 'frozen',
    items: [
      'Brussel sprouts',
      'Broccoli',
      'Mixed veggies',
      'Blueberries',
      'Mixed berries',
    ],
  },
  {
    section: 'Frozen',
    sub: 'Seafood',
    dept: 'frozen',
    items: [
      ['Salmon', { note: 'frozen' }],
      'Pacific whiting',
      'Shrimp',
    ],
  },
  {
    section: 'Frozen',
    sub: 'Meals & Sides',
    dept: 'frozen',
    items: [
      'Meatballs',
      'Nuggets',
      'Grilled chicken strips',
      'Pizza',
      'Ice cream',
    ],
  },

  // ── Refrigerated ───────────────────────────────────────────────────────
  {
    section: 'Refrigerated',
    sub: 'Dairy & Eggs',
    dept: 'dairy',
    items: [
      'Almond milk',
      ['Cow milk', { note: 'small' }],
      'Oat milk',
      'Orange juice',
      'Eggs',
      'Butter',
      'Greek light vanilla yogurt',
      'Greek yogurt cups',
      'Sour cream',
      'Cream cheese',
      'Cottage cheese',
    ],
  },
  {
    section: 'Refrigerated',
    sub: 'Cheese',
    dept: 'dairy',
    items: [
      'Cheddar',
      'Mozzarella',
      ['Feta', { note: '1 for the salad', person: 'p1' }],
      'Shredded cheese',
      'Cheese slices',
      'Grated Parmesan',
    ],
  },
  {
    section: 'Refrigerated',
    sub: 'Meat & Seafood',
    dept: 'meat',
    items: [
      'Ground beef',
      'Ground turkey',
      'Chicken breast',
      ['Salmon', { note: 'fresh', id: 'salmon-fresh' }],
      'Filet mignon',
      ['Low sodium turkey', { note: 'deli counter' }],
    ],
  },
  {
    section: 'Refrigerated',
    sub: 'Bacon & Sausage',
    dept: 'meat',
    items: [
      'Turkey bacon',
      'Bacon',
      'Pre-cooked bacon',
      'Chicken sausage',
      'Turkey sausage',
    ],
  },
  {
    section: 'Refrigerated',
    sub: 'Cold Cuts',
    dept: 'deli',
    items: [
      'Sliced turkey',
      'Salami',
      'Various lunch meat',
      'Smoked salmon',
    ],
  },
  {
    section: 'Refrigerated',
    sub: 'Prepared & Dips',
    dept: 'deli',
    items: ['Chicken salad', 'Hummus', 'Tzatziki'],
  },

  // ── Bakery & Bread ─────────────────────────────────────────────────────
  {
    section: 'Bakery & Bread',
    sub: 'Bread',
    dept: 'bakery',
    items: [
      'Sliced whole wheat bread',
      ['Publix fresh bread', { store: 'publix' }],
      'Hamburger buns',
      ['Bagels', { person: 'p1', id: 'bagels-p1' }],
      ['Bagels', { person: 'p2', id: 'bagels-p2' }],
    ],
  },
  {
    section: 'Bakery & Bread',
    sub: 'Tortillas',
    dept: 'bakery',
    items: ['Wheat tortillas', 'Corn tortillas'],
  },

  // ── Pantry ─────────────────────────────────────────────────────────────
  {
    section: 'Pantry',
    sub: 'Snacks',
    dept: 'snacks',
    items: [
      ['Snacks', { person: 'p1', id: 'snacks-p1' }],
      ['Snacks', { person: 'p2', id: 'snacks-p2' }],
      'Pretzels',
      'Blue corn tortilla chips',
      ['Nuts', { note: 'only if BOGO', dealOnly: true }],
      'Applesauce',
      'Jello / pudding',
    ],
  },
  {
    section: 'Pantry',
    sub: 'Breakfast',
    dept: 'breakfast',
    items: [
      ['Cereal', { person: 'p1', id: 'cereal-p1' }],
      'Oats',
    ],
  },
  {
    section: 'Pantry',
    sub: 'Oils, Sauces & Condiments',
    dept: 'condiments',
    items: [
      'Olive oil',
      'Olive oil spray',
      'Mayo',
      'Peanut butter',
      'Soy sauce',
      'Salsa',
      'Balsamic vinaigrette',
      'White wine vinegar',
      'Chile sauce',
      'Syrup',
      'Ranch',
    ],
  },
  {
    section: 'Pantry',
    sub: 'Pasta & Sauces',
    dept: 'pasta',
    items: [
      'Alfredo sauce',
      'Pasta sauce',
      'Penne',
      'Spaghetti',
      'Orzo',
      'Rice',
    ],
  },
  {
    section: 'Pantry',
    sub: 'Canned & Dry Goods',
    dept: 'canned',
    items: [
      'Chickpeas',
      ['Mushrooms', { note: 'canned', id: 'mushrooms-canned' }],
      'Cannellini beans',
      ['Tuna', { note: 'canned' }],
      'Corn',
      'Canned asparagus',
      'Potatoes au gratin',
    ],
  },
  {
    section: 'Pantry',
    sub: 'Salad Toppings',
    dept: 'condiments',
    items: [
      'Cranberry mix',
      'Crunchy salad toppings',
      'Parm crisps',
      'Croutons',
      'French onions',
      'Bacon bits',
      'Protein salad mix',
    ],
  },
  {
    section: 'Pantry',
    sub: 'Nuts & Dried Fruit',
    dept: 'snacks',
    items: ['Almonds', 'Pecans', 'Pitted dates'],
  },
  {
    section: 'Pantry',
    sub: 'Spices & Seasonings',
    dept: 'spices',
    items: [
      'Salt',
      'Sea salt',
      'Ground black pepper',
      'Peppercorn',
      'Garlic powder',
      'Minced garlic',
      'Lime pepper',
      'Lime juice',
      'Lemon juice',
      'Smoked paprika',
      ['Parsley', { note: 'dry', id: 'parsley-dry' }],
      'Thyme leaves',
      'Red pepper flakes',
      'Sesame seeds',
      ['Dill', { note: 'dry', id: 'dill-dry' }],
      'Chives',
      'Ground mustard',
      'Sugar',
    ],
  },

  // ── Drinks ─────────────────────────────────────────────────────────────
  {
    section: 'Drinks',
    sub: 'Drinks',
    dept: 'drinks',
    items: [
      ['La Croix', { person: 'p1', id: 'la-croix-p1' }],
      ['La Croix', { person: 'p2', id: 'la-croix-p2' }],
      ['Soda', { person: 'p1', id: 'soda-p1' }],
      ['Soda', { person: 'p2', id: 'soda-p2' }],
      'Celsius',
      'Monster',
      'Liquid IV',
    ],
  },

  // ── Household ──────────────────────────────────────────────────────────
  {
    section: 'Household',
    sub: 'Kitchen & Storage',
    dept: 'kitchen',
    items: [
      'Gallon Ziploc',
      'Sandwich Ziploc',
      'Aluminum foil',
      'Parchment paper',
    ],
  },
  {
    section: 'Household',
    sub: 'Paper Goods',
    dept: 'paper',
    items: ['Trash bags', 'Toilet paper', 'Paper towels'],
  },
  {
    section: 'Household',
    sub: 'Cleaning',
    dept: 'cleaning',
    items: [
      '409',
      'Dishwasher pods',
      'Lime Away',
      'Mildew remover',
      'Cleaning bleach',
      'Cleaning gloves',
    ],
  },
  {
    section: 'Household',
    sub: 'Laundry',
    dept: 'laundry',
    items: ['Laundry detergent', 'Fabric softener'],
  },
  {
    section: 'Household',
    sub: 'Personal Care',
    dept: 'personalcare',
    items: [
      'Toothpaste',
      'Body wash',
      'Conditioner',
      'Face wash',
      'Deodorant',
    ],
  },
];

/**
 * Seed household members. Names are set in the app (Setup → Household), not
 * in code — these are placeholders to be renamed on first run, and people can
 * be added or removed at any time.
 */
export const DEFAULT_PEOPLE = [
  { id: 'p1', name: 'Person 1' },
  { id: 'p2', name: 'Person 2' },
];

function slug(name) {
  return name
    .toLowerCase()
    .replace(/[—–]/g, '-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function expand() {
  const out = [];
  for (const group of SEED) {
    for (const entry of group.items) {
      const [name, meta] = Array.isArray(entry) ? entry : [entry, {}];
      out.push({
        id: meta.id ?? slug(name),
        name,
        section: group.section,
        sub: group.sub,
        dept: meta.dept ?? group.dept,
        note: meta.note ?? '',
        person: meta.person ?? null,
        store: meta.store ?? null,
        dealOnly: meta.dealOnly ?? false,
        seed: true,
      });
    }
  }
  return out;
}

export const CATALOG = expand();

export const SECTIONS = [...new Set(CATALOG.map((i) => i.section))];
