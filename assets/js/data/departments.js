/**
 * Store route for a Walmart Neighborhood Market.
 *
 * `order` is the walking order through the store, not the aisle number —
 * perimeter departments (produce, meat, dairy) are walked first, then the
 * center aisles in numeric order. `aisle` is what the sign overhead says.
 *
 * This is a sensible default layout, not live store data: Walmart publishes
 * no per-store aisle API. Every department below can be renumbered from
 * Settings, and every item can be reassigned to a different department, so
 * the route can be tuned to the store you actually shop.
 */
export const DEPARTMENTS = [
  {
    id: 'produce',
    name: 'Produce',
    aisle: 'Front',
    order: 10,
    signage: 'Fresh Fruit & Vegetables',
  },
  {
    id: 'bakery',
    name: 'Bakery & Bread',
    aisle: 'A1',
    order: 20,
    signage: 'Bread, Tortillas, Bakery',
  },
  {
    id: 'deli',
    name: 'Deli & Prepared',
    aisle: 'A2',
    order: 30,
    signage: 'Lunch Meat, Dips, Prepared Foods',
  },
  {
    id: 'meat',
    name: 'Meat & Seafood',
    aisle: 'Back wall',
    order: 40,
    signage: 'Fresh Meat, Poultry, Seafood',
  },
  {
    id: 'dairy',
    name: 'Dairy & Eggs',
    aisle: 'Back wall',
    order: 50,
    signage: 'Milk, Eggs, Cheese, Yogurt',
  },
  {
    id: 'frozen',
    name: 'Frozen',
    aisle: 'A3–A4',
    order: 60,
    signage: 'Frozen Foods, Ice Cream',
  },
  {
    id: 'breakfast',
    name: 'Breakfast & Cereal',
    aisle: 'A5',
    order: 70,
    signage: 'Cereal, Oatmeal, Breakfast',
  },
  {
    id: 'canned',
    name: 'Canned & Dry Goods',
    aisle: 'A6',
    order: 80,
    signage: 'Canned Vegetables, Beans, Soup',
  },
  {
    id: 'pasta',
    name: 'Pasta, Rice & Sauces',
    aisle: 'A7',
    order: 90,
    signage: 'Pasta, Rice, Pasta Sauce',
  },
  {
    id: 'condiments',
    name: 'Condiments & Salad Toppings',
    aisle: 'A8',
    order: 100,
    signage: 'Condiments, Dressing, Oils, Salad Toppers',
  },
  {
    id: 'spices',
    name: 'Spices & Baking',
    aisle: 'A9',
    order: 110,
    signage: 'Spices, Baking, Sugar',
  },
  {
    id: 'snacks',
    name: 'Snacks & Chips',
    aisle: 'A10',
    order: 120,
    signage: 'Chips, Crackers, Nuts, Cookies',
  },
  {
    id: 'drinks',
    name: 'Drinks',
    aisle: 'A11',
    order: 130,
    signage: 'Soda, Water, Energy Drinks',
  },
  {
    id: 'paper',
    name: 'Paper & Household',
    aisle: 'A12',
    order: 140,
    signage: 'Paper Towels, Bath Tissue, Trash Bags',
  },
  {
    id: 'cleaning',
    name: 'Cleaning Supplies',
    aisle: 'A13',
    order: 150,
    signage: 'Household Cleaners',
  },
  {
    id: 'laundry',
    name: 'Laundry',
    aisle: 'A14',
    order: 160,
    signage: 'Detergent, Fabric Care',
  },
  {
    id: 'kitchen',
    name: 'Kitchen & Storage',
    aisle: 'A15',
    order: 170,
    signage: 'Food Storage, Foil, Wraps',
  },
  {
    id: 'personalcare',
    name: 'Personal Care',
    aisle: 'A16',
    order: 180,
    signage: 'Health & Beauty',
  },
  {
    id: 'other',
    name: 'Unsorted',
    aisle: '—',
    order: 999,
    signage: 'Not yet assigned to an aisle',
  },
];

export const DEPARTMENT_BY_ID = Object.fromEntries(
  DEPARTMENTS.map((d) => [d.id, d]),
);

export function departmentName(id) {
  return DEPARTMENT_BY_ID[id]?.name ?? 'Unsorted';
}
