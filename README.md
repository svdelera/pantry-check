# Pantry and Fridge Check
 
A small web app for tracking what's in your pantry, fridge, freezer, and bathroom, and turning whatever is low into a shopping list. Sign in with Google and your list syncs across your phone and computer.
 
**Live app:** https://pantry-check-63fee.web.app
 
## Features
 
- Track items by place: Pantry, Fridge, Freezer, Bathroom
- Set a stock level for each item: Out, Low, OK, or Full
- Automatic shopping list from items that are Out or Low, plus anything you add manually
- One-time buys that go on the list without being tracked afterwards
- Optional price, unit, and quantity per item, with a running total in your own currency
- Filters for "Low and out" and "Not checked in 2 weeks"
- Drag an item to another shelf to move it
- Undo for accidental changes
- CSV export of your list
- Works offline-first: a local copy is kept in the browser, and syncs to Firestore when you're signed in
