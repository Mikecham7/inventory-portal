const API_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3001/api/inventory'
  : '/api/inventory';

const defaultInventory = [
  {
    id: 1,
    itemName: 'Industrial Drill',
    sku: 'IND-DR-1001',
    category: 'Tools',
    quantity: 12,
    unitPrice: 189.99,
    reorderLevel: 5,
    location: 'Aisle A-1',
    status: 'In Stock',
    lastUpdated: new Date().toISOString()
  },
  {
    id: 2,
    itemName: 'Safety Gloves',
    sku: 'PPE-GL-2040',
    category: 'Safety',
    quantity: 4,
    unitPrice: 24.5,
    reorderLevel: 8,
    location: 'B-12',
    status: 'Low Stock',
    lastUpdated: new Date().toISOString()
  },
  {
    id: 3,
    itemName: 'Hydraulic Hose',
    sku: 'MEC-HS-3308',
    category: 'Machinery',
    quantity: 0,
    unitPrice: 64.0,
    reorderLevel: 3,
    location: 'C-3',
    status: 'Out of Stock',
    lastUpdated: new Date().toISOString()
  }
];

const state = {
  items: [],
  searchTerm: ''
};

const tableBody = document.getElementById('inventoryTableBody');
const searchInput = document.getElementById('searchInput');
const inventoryForm = document.getElementById('inventoryForm');
const modal = document.getElementById('itemModal');
const modalTitle = document.getElementById('modalTitle');
const openAddModal = document.getElementById('openAddModal');
const closeModalBtn = document.getElementById('closeModal');
const cancelBtn = document.getElementById('cancelBtn');

function formatCurrency(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(Number(value || 0));
}

function renderStats(items) {
  const totalItems = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const lowStock = items.filter((item) => Number(item.quantity || 0) <= Number(item.reorderLevel || 0)).length;
  const inventoryValue = items.reduce((sum, item) => sum + (Number(item.quantity || 0) * Number(item.unitPrice || 0)), 0);
  const activeSkus = new Set(items.map((item) => item.sku)).size;

  document.getElementById('totalItems').textContent = totalItems;
  document.getElementById('lowStockCount').textContent = lowStock;
  document.getElementById('inventoryValue').textContent = formatCurrency(inventoryValue);
  document.getElementById('activeSkus').textContent = activeSkus;
  document.getElementById('summaryStatus').textContent = lowStock > 0 ? 'Attention needed' : 'System online';
  document.getElementById('summaryMeta').textContent = `${items.length} tracked items`;
}

function getVisibleItems() {
  const term = state.searchTerm.trim().toLowerCase();

  if (!term) {
    return state.items;
  }

  return state.items.filter((item) => {
    const haystack = [
      item.itemName,
      item.sku,
      item.category,
      item.location,
      item.status
    ].join(' ').toLowerCase();

    return haystack.includes(term);
  });
}

function renderTable(items) {
  if (!items.length) {
    tableBody.innerHTML = '<tr><td colspan="8" class="empty-state">No inventory items match your search.</td></tr>';
    return;
  }

  tableBody.innerHTML = items.map((item) => {
    const statusClass = (item.status || 'In Stock').toLowerCase().replace(/\s+/g, '-');

    return `
      <tr>
        <td><strong>${item.itemName}</strong></td>
        <td>${item.sku}</td>
        <td>${item.category}</td>
        <td>${item.quantity}</td>
        <td>${formatCurrency(item.unitPrice)}</td>
        <td>${item.location}</td>
        <td><span class="badge ${statusClass}">${item.status || 'In Stock'}</span></td>
        <td>
          <div class="table-actions">
            <button class="action-btn edit" type="button" data-action="edit" data-id="${item.id}">Edit</button>
            <button class="action-btn delete" type="button" data-action="delete" data-id="${item.id}">Delete</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function renderInventory() {
  const visibleItems = getVisibleItems();
  renderStats(state.items);
  renderTable(visibleItems);
}

async function fetchInventory() {
  try {
    const response = await fetch(API_URL, { headers: { Accept: 'application/json' } });

    if (!response.ok) {
      throw new Error('Failed to load inventory');
    }

    const result = await response.json();
    state.items = Array.isArray(result) ? result : (result.data || defaultInventory);
  } catch (error) {
    console.warn('Using fallback inventory data:', error);
    state.items = defaultInventory;
  }

  renderInventory();
}

function openModal(mode = 'add', item = null) {
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');

  inventoryForm.reset();

  if (mode === 'edit' && item) {
    modalTitle.textContent = 'Edit item';
    inventoryForm.dataset.mode = 'edit';
    inventoryForm.dataset.id = item.id;

    Object.entries(item).forEach(([key, value]) => {
      const input = inventoryForm.elements.namedItem(key);
      if (input) {
        input.value = value;
      }
    });
    return;
  }

  modalTitle.textContent = 'Add item';
  inventoryForm.dataset.mode = 'add';
  delete inventoryForm.dataset.id;
}

function closeModal() {
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  inventoryForm.reset();
  delete inventoryForm.dataset.mode;
  delete inventoryForm.dataset.id;
}

async function submitInventoryForm(event) {
  event.preventDefault();

  const formData = new FormData(inventoryForm);
  const payload = {
    itemName: formData.get('itemName').toString().trim(),
    sku: formData.get('sku').toString().trim(),
    category: formData.get('category').toString().trim(),
    location: formData.get('location').toString().trim(),
    quantity: Number(formData.get('quantity')),
    unitPrice: Number(formData.get('unitPrice')),
    reorderLevel: Number(formData.get('reorderLevel')),
    status: formData.get('status').toString().trim(),
    lastUpdated: new Date().toISOString()
  };

  const mode = inventoryForm.dataset.mode || 'add';
  const itemId = inventoryForm.dataset.id;

  try {
    const method = mode === 'edit' ? 'PUT' : 'POST';
    const requestUrl = mode === 'edit' ? `${API_URL}/${itemId}` : API_URL;

    const response = await fetch(requestUrl, {
      method,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Unable to save item' }));
      throw new Error(error.message || 'Unable to save item');
    }

    closeModal();
    await fetchInventory();
  } catch (error) {
    alert(error.message || 'Something went wrong');
  }
}

async function deleteItem(itemId) {
  const confirmed = window.confirm('Delete this inventory item?');
  if (!confirmed) {
    return;
  }

  try {
    const response = await fetch(`${API_URL}/${itemId}`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      throw new Error('Delete failed');
    }

    await fetchInventory();
  } catch (error) {
    alert(error.message || 'Delete failed');
  }
}

searchInput.addEventListener('input', (event) => {
  state.searchTerm = event.target.value;
  renderInventory();
});

openAddModal.addEventListener('click', () => openModal('add'));
closeModalBtn.addEventListener('click', closeModal);
cancelBtn.addEventListener('click', closeModal);
inventoryForm.addEventListener('submit', submitInventoryForm);

document.addEventListener('click', (event) => {
  const target = event.target;

  if (target instanceof HTMLElement && target.dataset.action === 'edit') {
    const item = state.items.find((entry) => String(entry.id) === target.dataset.id);
    if (item) {
      openModal('edit', item);
    }
  }

  if (target instanceof HTMLElement && target.dataset.action === 'delete') {
    deleteItem(target.dataset.id);
  }

  if (target instanceof HTMLElement && target.dataset.close === 'true') {
    closeModal();
  }
});

fetchInventory();
