"""Split the Lisbon trip costs between the three of us."""

expenses = {
    "Ana": [("apartment", 420.00), ("tram passes", 19.50)],
    "Inês": [("dinner, Alfama", 86.40), ("Sintra train", 13.80)],
    "Demo": [("flights", 312.00), ("pastéis", 9.60)],
}

total = sum(cost for items in expenses.values() for _, cost in items)
share = total / len(expenses)

print(f"Total: {total:.2f} €  —  each: {share:.2f} €")
for person, items in expenses.items():
    paid = sum(cost for _, cost in items)
    balance = paid - share
    verb = "gets back" if balance > 0 else "owes"
    print(f"  {person:5} paid {paid:7.2f} €, {verb} {abs(balance):.2f} €")
