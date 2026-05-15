require('dotenv').config(); 
const express = require('express');
const app = express();
const path = require('path');
const db = require('./db');
const multer = require('multer');
const fs = require('fs');
const session = require('express-session');
const axios = require('axios');

const reviewRouter = require('./reviews');

const uploadDir = './public/uploads';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, uploadDir); },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

app.use(express.static('public')); 
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: 'my_shopping_secret',
    resave: false,
    saveUninitialized: true
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use('/api', reviewRouter);

const maskName = (name) => {
    if (!name) return "";
    if (name.length <= 2) return name[0] + "*";
    return name[0] + "*".repeat(name.length - 2) + name.slice(-1);
};

const maskPhone = (phone) => {
    if (!phone) return "";
    return phone.replace(/(\d{3})-(\d{3,4})-(\d{4})/, '$1-****-$3');
};

const checkLogin = (req, res, next) => {
    if (req.session.user) {
        next();
    } else {
        res.send('<script>alert("로그인이 필요한 서비스입니다."); location.href="/login";</script>');
    }
};

// --- 라우터 시작 ---

app.post('/cart/add/direct', async (req, res) => {
    if (!req.session.user) {
        return res.json({ success: false, message: "로그인이 필요합니다.", redirect: "/login" });
    }
    try {
        const { product_id, quantity } = req.body;
        const user_id = req.session.user.id;
        const [existing] = await db.query('SELECT * FROM cart WHERE user_id = ? AND product_id = ?', [user_id, product_id]);
        if (existing.length > 0) {
            await db.query('UPDATE cart SET quantity = ? WHERE id = ?', [quantity, existing[0].id]);
        } else {
            await db.query('INSERT INTO cart (user_id, product_id, quantity) VALUES (?, ?, ?)', [user_id, product_id, quantity]);
        }
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, message: "처리 중 오류가 발생했습니다." });
    }
});

app.get('/login', (req, res) => { res.render('login', { user: req.session.user }); });

app.post('/login', async (req, res) => {
    const { userid, password } = req.body;
    try {
        const [rows] = await db.query('SELECT * FROM users WHERE userid = ? AND password = ?', [userid, password]);
        if (rows.length > 0) {
            req.session.user = rows[0];
            res.send('<script>alert("로그인 성공!"); location.href="/";</script>');
        } else {
            res.send('<script>alert("아이디 또는 비밀번호가 틀렸습니다."); history.back();</script>');
        }
    } catch (err) { res.status(500).send(`로그인 오류: ${err.message}`); }
});

app.get('/signup', (req, res) => { res.render('signup', { user: req.session.user }); });

app.post('/signup', async (req, res) => {
    const { userid, password, username } = req.body;
    try {
        await db.query('INSERT INTO users (userid, password, username) VALUES (?, ?, ?)', [userid, password, username]);
        res.send('<script>alert("회원가입 완료!"); location.href="/login";</script>');
    } catch (err) { res.status(500).send(`회원가입 오류: ${err.message}`); }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// 관리자 관련 라우터 생략 (기존 유지)
app.get('/admin', (req, res) => { res.render('admin_login'); });
app.post('/admin/login', async (req, res) => {
    const userInputKey = req.body.keycode;
    const realAdminKey = process.env.ADMIN_KEY;
    if (userInputKey === realAdminKey) {
        req.session.isAdmin = true; 
        res.redirect('/admin/list');
    } else {
        res.send('<script>alert("❌ 키코드가 틀렸습니다."); history.back();</script>');
    }
});

app.get('/admin/list', async (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/admin');
    try {
        const [rows] = await db.query('SELECT * FROM products ORDER BY id DESC');
        res.render('admin_list', { products: rows });
    } catch (err) { res.status(500).send('목록 로드 실패'); }
});

app.get('/admin/orders', async (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/admin');
    try {
        const [orders] = await db.query('SELECT * FROM orders ORDER BY created_at DESC');
        for (let order of orders) {
            const [items] = await db.query(`SELECT oi.*, p.name, p.image_url FROM order_items oi JOIN products p ON oi.product_id = p.id WHERE oi.order_id = ?`, [order.id]);
            order.items = items; 
            order.receiver_name = maskName(order.receiver_name);
            order.receiver_phone = maskPhone(order.receiver_phone);
        }
        const [categoryStats] = await db.query(`SELECT p.category, SUM(oi.quantity) as total FROM order_items oi JOIN products p ON oi.product_id = p.id GROUP BY p.category`);
        res.render('admin_orders', { orders: orders, categoryStats: categoryStats });
    } catch (err) { res.status(500).send('주문 내역 로드 실패: ' + err.message); }
});

app.get('/admin/add', (req, res) => { res.render('admin_add'); });
app.post('/admin/add', upload.single('image_file'), async (req, res) => {
    try {
        const { name, price, category, target_month, stock, origin, shipping_fee } = req.body;
        const image_url = req.file ? `/uploads/${req.file.filename}` : '/images/default.jpg';
        const sql = `INSERT INTO products (name, price, image_url, category, target_month, stock, origin, shipping_fee) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
        await db.query(sql, [name, price, image_url, category, target_month, stock, origin, shipping_fee]);
        res.send('<script>alert("✅ 등록되었습니다!"); location.href="/admin/list";</script>');
    } catch (err) { res.status(500).send('등록 실패'); }
});

// 메인, 검색, 상세페이지 (기존 유지)
app.get('/search', async (req, res) => {
    try {
        const keyword = req.query.q || '';
        if (!keyword.trim()) return res.render('search', { keyword: '', results: [], user: req.session.user });
        const [results] = await db.query('SELECT * FROM products WHERE name LIKE ? ORDER BY name ASC', [`%${keyword}%`]);
        res.render('search', { keyword, results, user: req.session.user });
    } catch (err) { res.status(500).send('검색 오류'); }
});

app.get(['/', '/category/:type'], async (req, res) => {
    try {
        const category = req.params.type || '수산물';
        const [bestResults] = await db.query(`SELECT p.*, IFNULL(AVG(r.rating), 0) AS rating FROM products p LEFT JOIN reviews r ON p.id = r.product_id WHERE p.category = ? GROUP BY p.id ORDER BY p.sales_count DESC LIMIT 5`, [category]);
        const [monthlyResults] = await db.query(`SELECT p.*, IFNULL(AVG(r.rating), 0) AS rating FROM products p LEFT JOIN reviews r ON p.id = r.product_id WHERE p.category = ? GROUP BY p.id`, [category]);
        const monthlyData = {};
        for (let m = 1; m <= 12; m++) { monthlyData[m] = []; }
        monthlyResults.forEach(p => { if (p.target_month >= 1 && p.target_month <= 12) monthlyData[p.target_month].push(p); });
        res.render('index', { currentCategory: category, bestProducts: bestResults, monthlyData: monthlyData, user: req.session.user });
    } catch (err) { res.status(500).send('서버 에러'); }
});

// [수정 완료] 상품 상세 페이지 라우터 (리뷰 데이터 포함)
app.get('/product/:id', async (req, res) => {
    try {
        const product_id = req.params.id;

        // 1. 상품 기본 정보 조회
        const [products] = await db.query('SELECT * FROM products WHERE id = ?', [product_id]);
        
        if (products.length === 0) {
            return res.send('<script>alert("존재하지 않는 상품입니다."); history.back();</script>');
        }

        // 2. 해당 상품의 리뷰와 작성자 정보(userid 추가) 조회
        const [reviews] = await db.query(`
            SELECT r.*, u.userid, u.username 
            FROM reviews r 
            LEFT JOIN users u ON r.user_id = u.id 
            WHERE r.product_id = ? 
            ORDER BY r.created_at DESC
        `, [product_id]);

        // 3. 리뷰 통계 계산
        const totalReviews = reviews.length;
        const avgRating = totalReviews > 0 
            ? (reviews.reduce((sum, r) => sum + r.rating, 0) / totalReviews).toFixed(1) 
            : 0;

        // 4. 모든 데이터를 detail.ejs로 전달
        res.render('detail', { 
            product: products[0], 
            reviews: reviews, 
            totalReviews: totalReviews, 
            avgRating: avgRating, 
            user: req.session.user 
        });

    } catch (err) {
        console.error("상세 페이지 로드 오류:", err);
        res.status(500).send('상세 정보를 불러오는 중 오류가 발생했습니다.');
    }
});

// 장바구니, 주문 처리 (기존 유지)
app.post('/cart/add', checkLogin, async (req, res) => {
    try {
        const { product_id, quantity } = req.body;
        const user_id = req.session.user.id;
        const [existing] = await db.query('SELECT * FROM cart WHERE user_id = ? AND product_id = ?', [user_id, product_id]);
        if (existing.length > 0) {
            await db.query('UPDATE cart SET quantity = quantity + ? WHERE id = ?', [parseInt(quantity), existing[0].id]);
        } else {
            await db.query('INSERT INTO cart (user_id, product_id, quantity) VALUES (?, ?, ?)', [user_id, product_id, quantity]);
        }
        res.send(`<script>if (confirm("장바구니에 담겼습니다! 바로 확인하시겠습니까?")) { location.href = "/cart"; } else { history.back(); }</script>`);
    } catch (err) { res.status(500).send('장바구니 담기 실패'); }
});

app.get('/cart', checkLogin, async (req, res) => {
    try {
        const user_id = req.session.user.id;
        const [items] = await db.query(`SELECT c.id AS cart_id, p.id AS product_id, p.name, p.price, p.image_url, c.quantity, p.shipping_fee, p.stock FROM cart c JOIN products p ON c.product_id = p.id WHERE c.user_id = ?`, [user_id]);
        res.render('cart', { cartItems: items, user: req.session.user });
    } catch (err) { res.status(500).send('장바구니 조회 실패'); }
});

app.get('/checkout', checkLogin, async (req, res) => {
    try {
        const user_id = req.session.user.id;
        const [items] = await db.query(`SELECT c.id AS cart_id, p.name, p.price, p.image_url, c.quantity, p.shipping_fee, p.stock FROM cart c JOIN products p ON c.product_id = p.id WHERE c.user_id = ?`, [user_id]);
        if (items.length === 0) return res.send('<script>alert("주문할 상품이 없습니다."); location.href="/cart";</script>');
        res.render('checkout', { orderItems: items, user: req.session.user });
    } catch (err) { res.status(500).send('주문 페이지 로드 실패'); }
});

app.post('/order/process', checkLogin, async (req, res) => {
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const user_id = req.session.user.id;
        const { receiver_name, receiver_phone, address, address_detail } = req.body;
        const [cartItems] = await conn.query(`SELECT c.product_id, c.quantity, p.price, p.stock, p.name, p.shipping_fee FROM cart c JOIN products p ON c.product_id = p.id WHERE c.user_id = ?`, [user_id]);
        let total_price = 0, max_shipping = 0;
        for (const item of cartItems) {
            total_price += item.price * item.quantity;
            max_shipping = Math.max(max_shipping, item.shipping_fee);
        }
        const [orderRes] = await conn.query(`INSERT INTO orders (user_id, receiver_name, receiver_phone, address, address_detail, total_price) VALUES (?, ?, ?, ?, ?, ?)`, [user_id, receiver_name, receiver_phone, address, address_detail, total_price + max_shipping]);
        const order_id = orderRes.insertId;
        for (const item of cartItems) {
            await conn.query(`UPDATE products SET stock = stock - ? WHERE id = ?`, [item.quantity, item.product_id]);
            await conn.query(`INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?, ?, ?, ?)`, [order_id, item.product_id, item.quantity, item.price]);
        }
        await conn.query(`DELETE FROM cart WHERE user_id = ?`, [user_id]);
        await conn.commit(); 
        res.send(`<script>alert("주문 완료!"); location.href="/my/orders";</script>`);
    } catch (err) { await conn.rollback(); res.send(`<script>alert("${err.message}"); history.back();</script>`); } finally { conn.release(); }
});

app.get('/my/orders', checkLogin, async (req, res) => {
    try {
        const user_id = req.session.user.id;
        const [orders] = await db.query(`SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC`, [user_id]);
        for (let order of orders) {
            const [items] = await db.query(`SELECT oi.*, p.name, p.image_url FROM order_items oi JOIN products p ON oi.product_id = p.id WHERE oi.order_id = ?`, [order.id]);
            order.items = items; 
        }
        res.render('order_list', { orders, user: req.session.user });
    } catch (err) { res.status(500).send('주문 내역 로드 실패'); }
});

// --- [여기가 핵심!] 마이페이지 및 정보 수정 통합 섹션 ---

app.get('/mypage', checkLogin, async (req, res) => {
    try {
        const user_id = req.session.user.id;

        // 1. 리뷰 목록 조회
        const [myReviews] = await db.query(`SELECT r.*, p.name as p_name, p.image_url FROM reviews r JOIN products p ON r.product_id = p.id WHERE r.user_id = ? ORDER BY r.created_at DESC`, [user_id]);

        // 2. 최근 주문 요약
        const [myOrders] = await db.query(`SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 3`, [user_id]);
        for (let order of myOrders) {
            const [items] = await db.query(`SELECT oi.*, p.name, p.image_url FROM order_items oi JOIN products p ON oi.product_id = p.id WHERE oi.order_id = ?`, [order.id]);
            order.items = items;
        }

        // 3. 지출 통계 조회
        const [statsResult] = await db.query(`
            SELECT p.category, SUM(oi.price * oi.quantity) as total 
            FROM orders o
            JOIN order_items oi ON o.id = oi.order_id
            JOIN products p ON oi.product_id = p.id
            WHERE o.user_id = ?
            GROUP BY p.category
        `, [user_id]);

        res.render('mypage', { 
            user: req.session.user, 
            reviews: myReviews, 
            orders: myOrders,
            stats: statsResult 
        });
    } catch (err) {
        console.error("마이페이지 로드 오류:", err);
        res.status(500).send("로드 중 오류 발생");
    }
});

app.post('/my/update', checkLogin, async (req, res) => {
    try {
        const { username, new_password, address, address_detail } = req.body;
        const user_id = req.session.user.id;
        let sql = "UPDATE users SET username = ?, address = ?, address_detail = ? ";
        let params = [username, address, address_detail];
        if (new_password && new_password.trim() !== "") {
            sql += ", password = ? ";
            params.push(new_password);
        }
        sql += " WHERE id = ?";
        params.push(user_id);
        await db.query(sql, params);
        req.session.user.username = username;
        req.session.user.address = address;
        req.session.user.address_detail = address_detail;
        res.send('<script>alert("회원 정보와 주소가 저장되었습니다."); location.href="/mypage";</script>');
    } catch (err) { res.status(500).send("수정 오류"); }
});

// 결제 성공 승인 라우터 (토스페이먼츠 연동)
app.get('/order/success', checkLogin, async (req, res) => {
    const { paymentKey, orderId, amount } = req.query;
    const user_id = req.session.user.id;
    const conn = await db.getConnection();

    try {
        // 토스페이먼츠 승인 API 호출 (윤섭님 키 기준)
        const widgetSecretKey = "test_sk_E92LAa5PVb57jK6znwzW37YmpXyJ"; 
        const encryptedSecretKey = "Basic " + Buffer.from(widgetSecretKey + ":").toString("base64");

        await axios.post("https://api.tosspayments.com/v1/payments/confirm", 
            { orderId, amount, paymentKey }, 
            { headers: { Authorization: encryptedSecretKey, "Content-Type": "application/json" } }
        );

        await conn.beginTransaction();

        // 장바구니 품목 가져오기
        const [cartItems] = await conn.query(`
            SELECT c.product_id, c.quantity, p.price, p.stock, p.name 
            FROM cart c JOIN products p ON c.product_id = p.id 
            WHERE c.user_id = ? FOR UPDATE`, [user_id]
        );

        // 주문 생성 (주소 정보는 세션에서 가져옴)
        const [orderResult] = await conn.query(
            'INSERT INTO orders (user_id, total_price, status, receiver_name, receiver_phone, address, address_detail) VALUES (?, ?, ?, ?, ?, ?, ?)', 
            [user_id, amount, '결제완료', req.session.user.username, '010-0000-0000', req.session.user.address || '기본 주소', req.session.user.address_detail || '상세 주소']
        );
        
        const new_order_id = orderResult.insertId; 

        // 상품 재고 차감 및 주문 품목 추가
        for (const item of cartItems) {
            await conn.query('UPDATE products SET stock = stock - ?, sales_count = sales_count + ? WHERE id = ?', [item.quantity, item.quantity, item.product_id]);
            await conn.query('INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?, ?, ?, ?)', [new_order_id, item.product_id, item.quantity, item.price]);
        }

        // 장바구니 비우기
        await conn.query('DELETE FROM cart WHERE user_id = ?', [user_id]);
        
        await conn.commit();
        res.send(`<script>alert("결제가 성공적으로 완료되었습니다!"); location.href="/mypage";</script>`);

    } catch (err) {
        if (conn) await conn.rollback();
        console.error("결제 승인 에러:", err);
        res.send(`<script>alert("결제 승인 중 오류가 발생했습니다."); location.href="/cart";</script>`);
    } finally {
        if (conn) conn.release();
    }
});

// 관리자 상품 수정 페이지 호출 (GET)
app.get('/admin/edit/:id', async (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/admin');
    try {
        const [rows] = await db.query('SELECT * FROM products WHERE id = ?', [req.params.id]);
        if (rows.length > 0) {
            res.render('admin_edit', { product: rows[0] });
        } else {
            res.send('<script>alert("해당 상품이 존재하지 않습니다."); location.href="/admin/list";</script>');
        }
    } catch (err) {
        console.error(err);
        res.status(500).send('상품 정보를 불러오는 중 에러가 발생했습니다.');
    }
});

// 관리자 상품 수정 처리 (POST)
app.post('/admin/edit/:id', upload.single('image_file'), async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).send('권한이 없습니다.');
    try {
        const { name, price, category, target_month, stock, origin, shipping_fee } = req.body;
        const product_id = req.params.id;

        // 1. 기본 수정 쿼리
        let sql = `UPDATE products SET name=?, price=?, category=?, target_month=?, stock=?, origin=?, shipping_fee=?`;
        let params = [name, price, category, target_month, stock, origin, shipping_fee];

        // 2. 이미지를 새로 업로드했다면 이미지 경로도 업데이트
        if (req.file) {
            sql += `, image_url=?`;
            params.push(`/uploads/${req.file.filename}`);
        }

        sql += ` WHERE id = ?`;
        params.push(product_id);

        await db.query(sql, params);

        res.send('<script>alert("✅ 상품 정보가 성공적으로 수정되었습니다!"); location.href="/admin/list";</script>');
    } catch (err) {
        console.error("상품 수정 오류:", err);
        res.status(500).send('수정 중 오류가 발생했습니다.');
    }
});

// 1. 선택 삭제 기능 (POST)
app.post('/cart/delete-selected', checkLogin, async (req, res) => {
    try {
        const { selected_items } = req.body;
        const user_id = req.session.user.id;
        
        if (selected_items) {
            // 선택된 아이템이 하나일 때는 문자열, 여러 개일 때는 배열로 들어오므로 처리
            const ids = Array.isArray(selected_items) ? selected_items : [selected_items];
            await db.query('DELETE FROM cart WHERE id IN (?) AND user_id = ?', [ids, user_id]);
        }
        res.redirect('/cart');
    } catch (err) {
        console.error(err);
        res.status(500).send('선택 삭제 중 오류 발생');
    }
});

// 2. 장바구니 전체 비우기 (GET)
app.get('/cart/clear', checkLogin, async (req, res) => {
    try {
        await db.query('DELETE FROM cart WHERE user_id = ?', [req.session.user.id]);
        res.redirect('/cart');
    } catch (err) {
        console.error(err);
        res.status(500).send('장바구니 비우기 중 오류 발생');
    }
});

// 3. 개별 항목 삭제 (GET) - 주소 형식이 /cart/delete/번호 인 경우
app.get('/cart/delete/:id', checkLogin, async (req, res) => {
    try {
        await db.query('DELETE FROM cart WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
        res.redirect('/cart');
    } catch (err) {
        console.error(err);
        res.status(500).send('삭제 중 오류 발생');
    }
});

// 4. 수량 수정 기능 (POST)
app.post('/cart/update', checkLogin, async (req, res) => {
    try {
        const { cart_id, quantity } = req.body;
        const user_id = req.session.user.id;

        // 재고 확인 후 업데이트
        const [product] = await db.query(
            `SELECT p.stock FROM products p JOIN cart c ON p.id = c.product_id WHERE c.id = ?`, 
            [cart_id]
        );

        if (parseInt(quantity) > product[0].stock) {
            return res.send(`<script>alert("현재 재고(${product[0].stock}개)까지만 주문 가능합니다."); location.href="/cart";</script>`);
        }

        await db.query('UPDATE cart SET quantity = ? WHERE id = ? AND user_id = ?', [quantity, cart_id, user_id]);
        res.redirect('/cart');
    } catch (err) {
        console.error(err);
        res.status(500).send('수량 수정 중 오류 발생');
    }
});

// --- [추가] 마이페이지 리뷰 수정 및 삭제 라우터 ---

// 1. 리뷰 수정 (POST)
app.post('/my/review/edit/:id', checkLogin, async (req, res) => {
    try {
        const review_id = req.params.id;
        const user_id = req.session.user.id;
        const { rating, content } = req.body;

        // [수정된 부분] WHERE id = ? 가 아니라 WHERE review_id = ? 입니다.
        const [result] = await db.query(
            'UPDATE reviews SET rating = ?, content = ? WHERE review_id = ? AND user_id = ?', 
            [rating, content, review_id, user_id]
        );

        if (result.affectedRows > 0) {
            res.json({ success: true });
        } else {
            res.json({ success: false, message: "권한이 없거나 존재하지 않는 리뷰입니다." });
        }
    } catch (err) {
        console.error("리뷰 수정 오류:", err);
        res.status(500).json({ success: false, message: "서버 오류가 발생했습니다." });
    }
});

// 2. 리뷰 삭제 (POST)
app.post('/my/review/delete/:id', checkLogin, async (req, res) => {
    try {
        const review_id = req.params.id;
        const user_id = req.session.user.id;

        // [수정된 부분] WHERE id = ? 가 아니라 WHERE review_id = ? 입니다.
        const [result] = await db.query('DELETE FROM reviews WHERE review_id = ? AND user_id = ?', [review_id, user_id]);
        
        if (result.affectedRows > 0) {
            res.json({ success: true });
        } else {
            res.json({ success: false, message: "권한이 없거나 이미 삭제된 리뷰입니다." });
        }
    } catch (err) {
        console.error("리뷰 삭제 오류:", err);
        res.status(500).json({ success: false, message: "서버 오류가 발생했습니다." });
    }
});

app.listen(3000, () => { console.log('서버 실행 중 (Port 3000)'); });