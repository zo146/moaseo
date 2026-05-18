const express = require('express');
const router = express.Router();
const db = require('./db');

router.post('/', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'UNAUTHORIZED' });
    }

    const { product_id, rating, content } = req.body;
    const user_id = req.session.user.id;

    try {
        const sql = `
            INSERT INTO reviews (product_id, user_id, rating, content) 
            VALUES (?, ?, ?, ?)
        `;
        await db.query(sql, [product_id, user_id, rating, content]);
        res.status(201).json({ success: true });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'ALREADY_REVIEWED' });
        }
        res.status(500).json({ error: error.message });
    }
});

router.get('/:product_id', async (req, res) => {
    const { product_id } = req.params;

    try {
        const listSql = `
            SELECT r.*, u.username as user_name 
            FROM reviews r
            JOIN users u ON r.user_id = u.id
            WHERE r.product_id = ? 
            ORDER BY r.created_at DESC
        `;
        const [reviews] = await db.query(listSql, [product_id]);

        const avgSql = `
            SELECT IFNULL(AVG(rating), 0) as avgRating, COUNT(*) as reviewCount 
            FROM reviews 
            WHERE product_id = ?
        `;
        const [stats] = await db.query(avgSql, [product_id]);

        res.json({
            reviews: reviews || [],
            avgRating: stats[0] && stats[0].avgRating ? parseFloat(stats[0].avgRating).toFixed(1) : "0.0",
            reviewCount: stats[0] && stats[0].reviewCount ? stats[0].reviewCount : 0
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.put('/:review_id', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'UNAUTHORIZED' });
    }

    const { review_id } = req.params;
    const { rating, content } = req.body;
    const user_id = req.session.user.id;

    try {
        const [review] = await db.query('SELECT user_id FROM reviews WHERE review_id = ?', [review_id]);
        
        if (review.length === 0) {
            return res.status(404).json({ error: 'NOT_FOUND' });
        }
        
        const reviewOwnerId = review[0].user_id || review[0].userid;
        if (reviewOwnerId !== user_id) {
            return res.status(403).json({ error: 'FORBIDDEN' });
        }

        await db.query('UPDATE reviews SET rating = ?, content = ? WHERE review_id = ?', [rating, content, review_id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.delete('/:review_id', async (req, res) => {
    const is_user_logged = req.session && req.session.user;
    const is_admin_logged = req.session && req.session.isAdmin;

    if (!is_user_logged && !is_admin_logged) {
        return res.status(401).json({ error: 'UNAUTHORIZED' });
    }

    const { review_id } = req.params;

    try {
        const [review] = await db.query('SELECT user_id FROM reviews WHERE review_id = ?', [review_id]);
        
        if (review.length === 0) {
            return res.status(404).json({ error: 'NOT_FOUND' });
        }

        if (is_admin_logged) {
            await db.query('DELETE FROM reviews WHERE review_id = ?', [review_id]);
            return res.json({ success: true });
        }

        const user_id = req.session.user.id;
        const reviewOwnerId = review[0].user_id || review[0].userid;
        
        if (reviewOwnerId !== user_id) {
            return res.status(403).json({ error: 'FORBIDDEN' });
        }

        await db.query('DELETE FROM reviews WHERE review_id = ?', [review_id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;